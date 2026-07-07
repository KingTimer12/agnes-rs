use tokio::sync::mpsc;

use crate::error::Result;
use crate::types::{Row, Rows};

/// A pull-based stream of rows produced by a background task.
///
/// The producer runs the query with sqlx's streaming `fetch` (constant memory,
/// server-side cursor on Postgres) and sends rows over a bounded channel. The
/// channel provides backpressure: the producer pauses once the buffer is full
/// and resumes as the consumer pulls, so a query over millions of rows never
/// materializes them all at once.
pub struct RowStream {
    rx: mpsc::Receiver<Result<Row>>,
}

/// The sending half an adapter's background task uses to emit rows.
pub type RowSender = mpsc::Sender<Result<Row>>;

/// Buffered rows held in the channel between the producer and the consumer.
pub const STREAM_BUFFER: usize = 256;

impl RowStream {
    pub fn new(rx: mpsc::Receiver<Result<Row>>) -> Self {
        Self { rx }
    }

    /// Create the channel and return the receiver-backed stream plus the sender
    /// for the producer task.
    pub fn channel() -> (RowSender, Self) {
        let (tx, rx) = mpsc::channel(STREAM_BUFFER);
        (tx, Self::new(rx))
    }

    /// Pull up to `n` rows. Returns fewer than `n` (possibly empty) at end of
    /// stream — an empty Vec means the stream is exhausted. Propagates the first
    /// producer error.
    pub async fn next_batch(&mut self, n: usize) -> Result<Rows> {
        let mut out = Vec::new();
        while out.len() < n {
            match self.rx.recv().await {
                Some(Ok(row)) => out.push(row),
                Some(Err(e)) => return Err(e),
                None => break,
            }
        }
        Ok(out)
    }
}
