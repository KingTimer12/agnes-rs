//! Read/write splitting across one master and N read replicas.
//!
//! Implemented as a [`DatabaseAdapter`] wrapper, so the executor, cache and
//! bridges are unchanged — the trait already separates `query` (reads) from
//! `execute` (writes):
//!
//! - **Writes** (`execute`) and **transactions** (`begin`) always go to the
//!   master.
//! - **Reads** (`query`, `stream`) pick the node with the lowest load, breaking
//!   ties by observed speed. "Load" is the current in-flight request count per
//!   node, bucketed so small differences don't matter — no DB round trip. The
//!   master is a read candidate too, but carries a fixed penalty added to its
//!   load so replicas win while the master is busy (and its own write traffic
//!   already raises its in-flight count, deprioritizing it further under write
//!   load).
//! - **Speed** is a secondary key only: within the same load bucket the node
//!   with the lower rolling-average read latency (an EWMA of past reads) wins.
//!   Load always dominates across buckets, so a saturated node is never chosen
//!   over an idle one no matter how fast it has been — speed only decides
//!   between nodes that are comparably (un)busy.
//! - **Failover:** a read that errors marks its node with a short cooldown and
//!   retries on the next-best node; cooled-down nodes are only used if every
//!   other candidate has also failed.

use std::sync::Arc;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use async_trait::async_trait;

use crate::adapter::{DatabaseAdapter, DbTransaction, Dialect};
use crate::error::{AgnesError, Result};
use crate::stream::RowStream;
use crate::types::{Rows, Value};

/// Monotonic milliseconds since first use (avoids wall-clock skew).
fn now_ms() -> u64 {
    static START: OnceLock<Instant> = OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// Tuning for read routing.
#[derive(Debug, Clone)]
pub struct ReplicationOptions {
    /// Load penalty added to the master when ranking read candidates. Higher =
    /// replicas are preferred more strongly; the master still absorbs reads when
    /// it is the least-loaded node (e.g. replicas saturated or in cooldown).
    pub master_read_penalty: i64,
    /// How long a node is skipped for reads after it returns an error.
    pub cooldown: Duration,
    /// In-flight counts are divided by this to form the load bucket used as the
    /// primary ranking key. Nodes in the same bucket are then ranked by latency,
    /// so this sets how large a load gap must be before it overrides speed.
    /// `1` = every extra in-flight request matters; larger = more tolerant.
    pub load_bucket: i64,
}

impl Default for ReplicationOptions {
    fn default() -> Self {
        Self {
            master_read_penalty: 100,
            cooldown: Duration::from_secs(5),
            load_bucket: 4,
        }
    }
}

struct Node {
    adapter: Arc<dyn DatabaseAdapter>,
    /// In-flight request count (reads and, for the master, writes).
    inflight: AtomicI64,
    /// Epoch (ms via [`now_ms`]) until which this node is skipped for reads.
    cooldown_until: AtomicU64,
    /// Rolling average read latency in microseconds (EWMA, alpha = 1/8). `0`
    /// until the node has served a read — an unmeasured node ranks first within
    /// its bucket so it gets tried and starts contributing data.
    latency_us: AtomicU64,
    is_master: bool,
}

impl Node {
    fn in_cooldown(&self) -> bool {
        now_ms() < self.cooldown_until.load(Ordering::Relaxed)
    }
}

/// RAII in-flight counter: increments on `enter`, decrements on drop — so the
/// count is correct even if the awaited query errors or is cancelled.
struct Inflight<'a>(&'a AtomicI64);

impl<'a> Inflight<'a> {
    fn enter(counter: &'a AtomicI64) -> Self {
        counter.fetch_add(1, Ordering::Relaxed);
        Inflight(counter)
    }
}

impl Drop for Inflight<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}

/// A master + read-replicas cluster behind the [`DatabaseAdapter`] interface.
pub struct ReplicatedAdapter {
    /// Index of the master in `nodes` (always 0).
    master: usize,
    nodes: Vec<Node>,
    opts: ReplicationOptions,
}

impl ReplicatedAdapter {
    pub fn new(
        master: Arc<dyn DatabaseAdapter>,
        replicas: Vec<Arc<dyn DatabaseAdapter>>,
        opts: ReplicationOptions,
    ) -> Self {
        let mut nodes = Vec::with_capacity(1 + replicas.len());
        nodes.push(Node {
            adapter: master,
            inflight: AtomicI64::new(0),
            cooldown_until: AtomicU64::new(0),
            latency_us: AtomicU64::new(0),
            is_master: true,
        });
        for r in replicas {
            nodes.push(Node {
                adapter: r,
                inflight: AtomicI64::new(0),
                cooldown_until: AtomicU64::new(0),
                latency_us: AtomicU64::new(0),
                is_master: false,
            });
        }
        Self {
            master: 0,
            nodes,
            opts,
        }
    }

    /// Primary ranking key: bucketed in-flight load (master penalty folded in).
    /// Dividing by `load_bucket` collapses small load differences so latency can
    /// break the tie, while a large gap still dominates.
    fn load_bucket(&self, n: &Node) -> i64 {
        let base = n.inflight.load(Ordering::Relaxed);
        let load = if n.is_master {
            base.saturating_add(self.opts.master_read_penalty)
        } else {
            base
        };
        load / self.opts.load_bucket.max(1)
    }

    /// Read-candidate node indices, best first. Sort key, in order: not in
    /// cooldown, then lowest load bucket, then lowest rolling latency. So load
    /// decides across buckets and speed only breaks ties within a bucket;
    /// cooled-down nodes sink last as a full-outage fallback.
    fn read_order(&self) -> Vec<usize> {
        let mut idx: Vec<usize> = (0..self.nodes.len()).collect();
        idx.sort_by_key(|&i| {
            let n = &self.nodes[i];
            (
                n.in_cooldown(),
                self.load_bucket(n),
                n.latency_us.load(Ordering::Relaxed),
            )
        });
        idx
    }

    fn mark_cooldown(&self, i: usize) {
        let until = now_ms().saturating_add(self.opts.cooldown.as_millis() as u64);
        self.nodes[i].cooldown_until.store(until, Ordering::Relaxed);
    }

    /// Fold a fresh read latency sample into a node's EWMA (alpha = 1/8). The
    /// first sample seeds the average directly so it isn't dragged down from 0.
    fn record_latency(&self, i: usize, sample_us: u64) {
        let cell = &self.nodes[i].latency_us;
        let prev = cell.load(Ordering::Relaxed);
        let next = if prev == 0 {
            sample_us
        } else {
            prev - prev / 8 + sample_us / 8
        };
        cell.store(next, Ordering::Relaxed);
    }
}

#[async_trait]
impl DatabaseAdapter for ReplicatedAdapter {
    async fn query(&self, sql: &str, params: &[Value]) -> Result<Rows> {
        let mut last_err: Option<AgnesError> = None;
        for i in self.read_order() {
            let _guard = Inflight::enter(&self.nodes[i].inflight);
            let start = Instant::now();
            match self.nodes[i].adapter.query(sql, params).await {
                Ok(rows) => {
                    self.record_latency(i, start.elapsed().as_micros() as u64);
                    return Ok(rows);
                }
                Err(e) => {
                    self.mark_cooldown(i);
                    last_err = Some(e);
                }
            }
        }
        Err(last_err.unwrap_or_else(|| AgnesError::Adapter("no read nodes available".into())))
    }

    async fn execute(&self, sql: &str, params: &[Value]) -> Result<u64> {
        let m = self.master;
        let _guard = Inflight::enter(&self.nodes[m].inflight);
        self.nodes[m].adapter.execute(sql, params).await
    }

    async fn query_primary(&self, sql: &str, params: &[Value]) -> Result<Rows> {
        // Read-your-writes: force the master so replica lag can't return stale data.
        let m = self.master;
        let _guard = Inflight::enter(&self.nodes[m].inflight);
        self.nodes[m].adapter.query(sql, params).await
    }

    fn dialect(&self) -> Dialect {
        self.nodes[self.master].adapter.dialect()
    }

    fn stream(&self, sql: &str, params: &[Value]) -> RowStream {
        // Route to the least-loaded reader at start-of-stream. A streamed error
        // surfaces on the channel, so there's no mid-stream failover; and a
        // long-lived stream isn't tracked as ongoing in-flight load.
        let i = self.read_order().first().copied().unwrap_or(self.master);
        self.nodes[i].adapter.stream(sql, params)
    }

    async fn begin(&self) -> Result<Box<dyn DbTransaction>> {
        // Transactions run on the master: they may write, and this gives
        // read-your-writes consistency within the transaction.
        self.nodes[self.master].adapter.begin().await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// Records which node handled each call and can be told to fail.
    struct FakeAdapter {
        name: &'static str,
        log: Arc<Mutex<Vec<String>>>,
        fail: bool,
    }

    #[async_trait]
    impl DatabaseAdapter for FakeAdapter {
        async fn query(&self, _sql: &str, _params: &[Value]) -> Result<Rows> {
            self.log
                .lock()
                .unwrap()
                .push(format!("query:{}", self.name));
            if self.fail {
                return Err(AgnesError::Adapter(format!("{} down", self.name)));
            }
            Ok(vec![])
        }
        async fn execute(&self, _sql: &str, _params: &[Value]) -> Result<u64> {
            self.log
                .lock()
                .unwrap()
                .push(format!("execute:{}", self.name));
            Ok(1)
        }
        fn dialect(&self) -> Dialect {
            Dialect::Postgres
        }
        fn stream(&self, _sql: &str, _params: &[Value]) -> RowStream {
            let (_tx, s) = RowStream::channel();
            s
        }
        async fn begin(&self) -> Result<Box<dyn DbTransaction>> {
            Err(AgnesError::Adapter("no tx in test".into()))
        }
    }

    fn node(
        name: &'static str,
        log: &Arc<Mutex<Vec<String>>>,
        fail: bool,
    ) -> Arc<dyn DatabaseAdapter> {
        Arc::new(FakeAdapter {
            name,
            log: log.clone(),
            fail,
        })
    }

    #[tokio::test]
    async fn writes_go_to_master() {
        let log = Arc::new(Mutex::new(vec![]));
        let a = ReplicatedAdapter::new(
            node("m", &log, false),
            vec![node("r1", &log, false)],
            ReplicationOptions::default(),
        );
        a.execute("INSERT", &[]).await.unwrap();
        assert_eq!(*log.lock().unwrap(), vec!["execute:m"]);
    }

    #[tokio::test]
    async fn reads_prefer_replica_over_master() {
        let log = Arc::new(Mutex::new(vec![]));
        let a = ReplicatedAdapter::new(
            node("m", &log, false),
            vec![node("r1", &log, false)],
            ReplicationOptions::default(), // master penalty 100 > replica load 0
        );
        a.query("SELECT", &[]).await.unwrap();
        assert_eq!(*log.lock().unwrap(), vec!["query:r1"]);
    }

    #[tokio::test]
    async fn read_falls_back_to_master_when_replica_fails() {
        let log = Arc::new(Mutex::new(vec![]));
        let a = ReplicatedAdapter::new(
            node("m", &log, false),
            vec![node("r1", &log, true)], // replica errors
            ReplicationOptions::default(),
        );
        a.query("SELECT", &[]).await.unwrap();
        // Tried replica first, then failed over to master.
        assert_eq!(*log.lock().unwrap(), vec!["query:r1", "query:m"]);
    }

    #[tokio::test]
    async fn query_primary_forces_master() {
        let log = Arc::new(Mutex::new(vec![]));
        let a = ReplicatedAdapter::new(
            node("m", &log, false),
            vec![node("r1", &log, false)],
            ReplicationOptions::default(),
        );
        a.query_primary("SELECT", &[]).await.unwrap();
        assert_eq!(*log.lock().unwrap(), vec!["query:m"]);
    }

    #[tokio::test]
    async fn latency_breaks_ties_within_a_load_bucket() {
        let log = Arc::new(Mutex::new(vec![]));
        let a = ReplicatedAdapter::new(
            node("m", &log, false),
            vec![node("r1", &log, false), node("r2", &log, false)],
            ReplicationOptions::default(),
        );
        // Same load (all idle → bucket 0); make r1 slower, r2 faster.
        a.nodes[1].latency_us.store(5000, Ordering::Relaxed); // r1
        a.nodes[2].latency_us.store(500, Ordering::Relaxed); // r2
        a.query("SELECT", &[]).await.unwrap();
        assert_eq!(*log.lock().unwrap(), vec!["query:r2"]);
    }

    #[tokio::test]
    async fn load_dominates_latency_across_buckets() {
        let log = Arc::new(Mutex::new(vec![]));
        let a = ReplicatedAdapter::new(
            node("m", &log, false),
            vec![node("r1", &log, false), node("r2", &log, false)],
            ReplicationOptions::default(), // bucket width 4
        );
        // r1 is blazing fast but saturated (a full bucket above r2); r2 slow but idle.
        a.nodes[1].latency_us.store(1, Ordering::Relaxed);
        a.nodes[1].inflight.fetch_add(8, Ordering::Relaxed); // bucket 2
        a.nodes[2].latency_us.store(9000, Ordering::Relaxed); // bucket 0
        a.query("SELECT", &[]).await.unwrap();
        // Busy-but-fast r1 loses to idle-but-slow r2: load gates speed.
        assert_eq!(*log.lock().unwrap(), vec!["query:r2"]);
    }

    #[tokio::test]
    async fn ewma_seeds_on_first_sample() {
        let log = Arc::new(Mutex::new(vec![]));
        let a = ReplicatedAdapter::new(node("m", &log, false), vec![], ReplicationOptions::default());
        a.record_latency(0, 4000);
        assert_eq!(a.nodes[0].latency_us.load(Ordering::Relaxed), 4000);
        // Second sample blends: 4000 - 500 + 100 = 3600.
        a.record_latency(0, 800);
        assert_eq!(a.nodes[0].latency_us.load(Ordering::Relaxed), 3600);
    }

    #[tokio::test]
    async fn master_only_serves_reads_when_alone() {
        let log = Arc::new(Mutex::new(vec![]));
        let a = ReplicatedAdapter::new(
            node("m", &log, false),
            vec![],
            ReplicationOptions::default(),
        );
        a.query("SELECT", &[]).await.unwrap();
        assert_eq!(*log.lock().unwrap(), vec!["query:m"]);
    }
}
