use std::sync::Arc;

use agnes_adapter_mysql::MySqlAdapter;
use agnes_adapter_postgres::PostgresAdapter;
use agnes_adapter_sqlite::SqliteAdapter;
use agnes_cache::{KvConfig, KvMotor};
use agnes_core::adapter::{DatabaseAdapter, PoolConfig};
use agnes_core::replicated::{ReplicatedAdapter, ReplicationOptions};
use agnes_core::cache::CacheBackend;
use agnes_core::executor::{Executor, Transaction as CoreTx};
use agnes_core::types::{QueryOptions, Value};
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyBytes, PyDict, PyList};
use pythonize::pythonize;
use tokio::runtime::Runtime;

fn err<E: std::fmt::Display>(e: E) -> PyErr {
    pyo3::exceptions::PyRuntimeError::new_err(e.to_string())
}

/// Convert a Python scalar into an agnes bound-parameter value.
fn py_to_value(obj: &Bound<'_, PyAny>) -> PyResult<Value> {
    if obj.is_none() {
        return Ok(Value::Null);
    }
    // bool must be checked before int (Python bool is a subclass of int).
    if let Ok(b) = obj.cast::<PyBool>() {
        return Ok(Value::Bool(b.is_true()));
    }
    if let Ok(b) = obj.cast::<PyBytes>() {
        return Ok(Value::Bytes(b.as_bytes().to_vec()));
    }
    if let Ok(i) = obj.extract::<i64>() {
        return Ok(Value::Int(i));
    }
    if let Ok(f) = obj.extract::<f64>() {
        return Ok(Value::Float(f));
    }
    if let Ok(s) = obj.extract::<String>() {
        return Ok(Value::Text(s));
    }
    Ok(Value::Text(obj.str()?.to_string()))
}

fn params_from(py_params: Option<&Bound<'_, PyList>>) -> PyResult<Vec<Value>> {
    let mut out = Vec::new();
    if let Some(list) = py_params {
        for item in list.iter() {
            out.push(py_to_value(&item)?);
        }
    }
    Ok(out)
}

fn options_from(opts: Option<&Bound<'_, PyDict>>) -> PyResult<QueryOptions> {
    let mut o = QueryOptions::default();
    if let Some(d) = opts {
        if let Some(v) = d.get_item("ttl")?
            && !v.is_none()
        {
            o.ttl_secs = Some(v.extract::<u64>()?);
        }
        if let Some(v) = d.get_item("cache_key")?
            && !v.is_none()
        {
            o.cache_key = Some(v.extract::<String>()?);
        }
        if let Some(v) = d.get_item("bypass_cache")?
            && !v.is_none()
        {
            o.bypass_cache = v.extract::<bool>()?;
        }
        if let Some(v) = d.get_item("read_primary")?
            && !v.is_none()
        {
            o.read_primary = v.extract::<bool>()?;
        }
    }
    Ok(o)
}

fn opt_string(d: &Bound<'_, PyDict>, key: &str) -> PyResult<Option<String>> {
    match d.get_item(key)? {
        Some(v) if !v.is_none() => Ok(Some(v.extract::<String>()?)),
        _ => Ok(None),
    }
}

fn opt_u32(d: &Bound<'_, PyDict>, key: &str) -> PyResult<Option<u32>> {
    match d.get_item(key)? {
        Some(v) if !v.is_none() => Ok(Some(v.extract::<u32>()?)),
        _ => Ok(None),
    }
}

fn opt_bool(d: &Bound<'_, PyDict>, key: &str) -> PyResult<Option<bool>> {
    match d.get_item(key)? {
        Some(v) if !v.is_none() => Ok(Some(v.extract::<bool>()?)),
        _ => Ok(None),
    }
}

/// Connect a single node's adapter for the given driver.
async fn connect_adapter(
    driver: &str,
    url: &str,
    pool: &PoolConfig,
    strip_tz: bool,
) -> Result<Arc<dyn DatabaseAdapter>, agnes_core::error::AgnesError> {
    let a: Arc<dyn DatabaseAdapter> = match driver {
        "postgres" | "postgresql" | "pg" => {
            Arc::new(PostgresAdapter::connect(url, pool, strip_tz).await?)
        }
        "mysql" | "mariadb" => Arc::new(MySqlAdapter::connect(url, pool, strip_tz).await?),
        "sqlite" => Arc::new(SqliteAdapter::connect(url, pool, strip_tz).await?),
        other => {
            return Err(agnes_core::error::AgnesError::Adapter(format!(
                "unknown driver: {other}"
            )));
        }
    };
    Ok(a)
}

/// Native database handle. Heavy lifting (pool, parser, cache) runs in Rust.
#[pyclass]
struct Database {
    executor: Arc<Executor>,
    rt: Arc<Runtime>,
}

#[pymethods]
impl Database {
    /// Connect from a config dict:
    ///   { driver, url, max_connections?, strip_timezone?,
    ///     cache?: { enabled, wal_path?, compaction_threshold? } }
    #[staticmethod]
    fn connect(py: Python<'_>, config: &Bound<'_, PyDict>) -> PyResult<Database> {
        let driver =
            opt_string(config, "driver")?.ok_or_else(|| err("config.driver is required"))?;
        let url = opt_string(config, "url")?.ok_or_else(|| err("config.url is required"))?;
        let strip_tz = opt_bool(config, "strip_timezone")?.unwrap_or(false);
        let secs = |v: Option<u32>| v.map(|s| std::time::Duration::from_secs(s as u64));
        let pool = PoolConfig {
            max_connections: opt_u32(config, "max_connections")?.unwrap_or(10),
            min_connections: opt_u32(config, "min_connections")?.unwrap_or(0),
            acquire_timeout: secs(opt_u32(config, "acquire_timeout_secs")?),
            idle_timeout: secs(opt_u32(config, "idle_timeout_secs")?),
            max_lifetime: secs(opt_u32(config, "max_lifetime_secs")?),
        };

        // Build the cache backend from the (GIL-held) config first.
        let cache: Option<Arc<dyn CacheBackend>> = match config.get_item("cache")? {
            Some(c) if !c.is_none() => {
                let cd = c.cast::<PyDict>().map_err(|e| err(e.to_string()))?;
                if opt_bool(cd, "enabled")?.unwrap_or(false) {
                    let wal_path = opt_string(cd, "wal_path")?.map(std::path::PathBuf::from);
                    if let Some(p) = &wal_path
                        && let Some(dir) = p.parent()
                    {
                        std::fs::create_dir_all(dir).map_err(err)?;
                    }
                    let threshold = opt_u32(cd, "compaction_threshold")?.unwrap_or(1024) as u64;
                    let kv = KvMotor::new(KvConfig {
                        wal_path,
                        compaction_threshold: threshold,
                    })
                    .map_err(err)?;
                    Some(Arc::new(kv))
                } else {
                    None
                }
            }
            _ => None,
        };

        // Read-replica config (master/slave mode) — extract while the GIL is held.
        let replicas: Vec<String> = match config.get_item("replicas")? {
            Some(v) if !v.is_none() => v.extract::<Vec<String>>()?,
            _ => Vec::new(),
        };
        let master_read_penalty = opt_u32(config, "master_read_penalty")?.unwrap_or(100) as i64;
        let replica_cooldown =
            std::time::Duration::from_secs(opt_u32(config, "replica_cooldown_secs")?.unwrap_or(5) as u64);

        let rt = Arc::new(
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .build()
                .map_err(err)?,
        );

        let driver = driver.to_ascii_lowercase();
        let adapter = py
            .detach(|| {
                rt.block_on(async {
                    let master = connect_adapter(&driver, &url, &pool, strip_tz).await?;
                    if replicas.is_empty() {
                        return Ok::<Arc<dyn DatabaseAdapter>, agnes_core::error::AgnesError>(master);
                    }
                    let mut reps = Vec::with_capacity(replicas.len());
                    for r in &replicas {
                        reps.push(connect_adapter(&driver, r, &pool, strip_tz).await?);
                    }
                    let opts = ReplicationOptions {
                        master_read_penalty,
                        cooldown: replica_cooldown,
                    };
                    Ok(Arc::new(ReplicatedAdapter::new(master, reps, opts)) as Arc<dyn DatabaseAdapter>)
                })
            })
            .map_err(err)?;

        Ok(Database {
            executor: Arc::new(Executor::new(adapter, cache)),
            rt,
        })
    }

    #[pyo3(signature = (sql, params=None, opts=None))]
    fn query(
        &self,
        py: Python<'_>,
        sql: String,
        params: Option<&Bound<'_, PyList>>,
        opts: Option<&Bound<'_, PyDict>>,
    ) -> PyResult<Py<PyAny>> {
        let params = params_from(params)?;
        let opts = options_from(opts)?;
        let executor = self.executor.clone();
        let rt = self.rt.clone();
        let rows = py
            .detach(|| rt.block_on(async move { executor.query(&sql, &params, &opts).await }))
            .map_err(err)?;
        Ok(pythonize(py, &rows).map_err(err)?.unbind())
    }

    #[pyo3(signature = (sql, params=None))]
    fn mutate(
        &self,
        py: Python<'_>,
        sql: String,
        params: Option<&Bound<'_, PyList>>,
    ) -> PyResult<u64> {
        let params = params_from(params)?;
        let executor = self.executor.clone();
        let rt = self.rt.clone();
        py.detach(|| rt.block_on(async move { executor.mutate(&sql, &params).await }))
            .map_err(err)
    }

    /// Stream a read query row-by-row (constant memory). Pull batches from the
    /// returned handle with `next_batch(n)`; an empty list means end of stream.
    #[pyo3(signature = (sql, params=None))]
    fn stream(
        &self,
        py: Python<'_>,
        sql: String,
        params: Option<&Bound<'_, PyList>>,
    ) -> PyResult<RowStream> {
        let params = params_from(params)?;
        let executor = self.executor.clone();
        let rt = self.rt.clone();
        let inner = py.detach(|| rt.block_on(async move { executor.stream(&sql, &params) }));
        Ok(RowStream {
            inner: std::sync::Mutex::new(inner),
            rt: self.rt.clone(),
        })
    }

    /// Open an interactive transaction on a dedicated connection.
    fn begin_transaction(&self, py: Python<'_>) -> PyResult<Transaction> {
        let executor = self.executor.clone();
        let rt = self.rt.clone();
        let tx = py
            .detach(|| rt.block_on(async move { executor.begin().await }))
            .map_err(err)?;
        Ok(Transaction {
            inner: Arc::new(tokio::sync::Mutex::new(Some(tx))),
            rt: self.rt.clone(),
        })
    }
}

/// A live transaction handle. `query`/`mutate` run on the transaction's
/// connection; `commit`/`rollback` finish it.
#[pyclass]
struct Transaction {
    inner: Arc<tokio::sync::Mutex<Option<CoreTx>>>,
    rt: Arc<Runtime>,
}

#[pymethods]
impl Transaction {
    #[pyo3(signature = (sql, params=None, opts=None))]
    fn query(
        &self,
        py: Python<'_>,
        sql: String,
        params: Option<&Bound<'_, PyList>>,
        opts: Option<&Bound<'_, PyDict>>,
    ) -> PyResult<Py<PyAny>> {
        let _ = opts; // reads inside a transaction always hit the DB (no cache)
        let params = params_from(params)?;
        let inner = self.inner.clone();
        let rt = self.rt.clone();
        let rows = py.detach(|| {
            rt.block_on(async move {
                let mut guard = inner.lock().await;
                let tx = guard
                    .as_mut()
                    .ok_or_else(|| err("transaction already finished"))?;
                tx.query(&sql, &params).await.map_err(err)
            })
        })?;
        Ok(pythonize(py, &rows).map_err(err)?.unbind())
    }

    #[pyo3(signature = (sql, params=None))]
    fn mutate(
        &self,
        py: Python<'_>,
        sql: String,
        params: Option<&Bound<'_, PyList>>,
    ) -> PyResult<u64> {
        let params = params_from(params)?;
        let inner = self.inner.clone();
        let rt = self.rt.clone();
        py.detach(|| {
            rt.block_on(async move {
                let mut guard = inner.lock().await;
                let tx = guard
                    .as_mut()
                    .ok_or_else(|| err("transaction already finished"))?;
                tx.mutate(&sql, &params).await.map_err(err)
            })
        })
    }

    fn commit(&self, py: Python<'_>) -> PyResult<()> {
        let inner = self.inner.clone();
        let rt = self.rt.clone();
        py.detach(|| {
            rt.block_on(async move {
                let tx = inner
                    .lock()
                    .await
                    .take()
                    .ok_or_else(|| err("transaction already finished"))?;
                tx.commit().await.map_err(err)
            })
        })
    }

    fn rollback(&self, py: Python<'_>) -> PyResult<()> {
        let inner = self.inner.clone();
        let rt = self.rt.clone();
        py.detach(|| {
            rt.block_on(async move {
                let tx = inner
                    .lock()
                    .await
                    .take()
                    .ok_or_else(|| err("transaction already finished"))?;
                tx.rollback().await.map_err(err)
            })
        })
    }
}

/// A pull-based row stream. `next_batch(n)` returns up to `n` rows as a list of
/// dicts; an empty list means the stream is exhausted.
#[pyclass]
struct RowStream {
    inner: std::sync::Mutex<agnes_core::stream::RowStream>,
    rt: Arc<Runtime>,
}

#[pymethods]
impl RowStream {
    fn next_batch(&self, py: Python<'_>, n: usize) -> PyResult<Py<PyAny>> {
        let rows = py
            .detach(|| {
                let mut guard = self.inner.lock().unwrap();
                self.rt.block_on(guard.next_batch(n))
            })
            .map_err(err)?;
        Ok(pythonize(py, &rows).map_err(err)?.unbind())
    }
}

#[pymodule]
fn _native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<Database>()?;
    m.add_class::<Transaction>()?;
    m.add_class::<RowStream>()?;
    Ok(())
}
