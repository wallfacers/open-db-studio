//! Byte-bounded channel wrapper for migration pipeline backpressure.
//!
//! Wraps a standard `tokio::sync::mpsc` channel with a byte-capacity gate.
//! Before sending a message, the sender must acquire a byte permit from a
//! `Semaphore`. The receiver releases the permit after consuming the message.
//! This prevents the channel from accumulating arbitrary amounts of data
//! (DataX's `byteCapacity` pattern).

#![allow(dead_code)]

use std::sync::Arc;
use tokio::sync::{Semaphore, OwnedSemaphorePermit};

/// A token that tracks how many bytes a channel message occupies.
/// The token holds the semaphore permit — when dropped, the bytes are
/// released back to the pool, allowing the sender to send more data.
pub struct BytePermit {
    permit: OwnedSemaphorePermit,
}

impl BytePermit {
    fn new(permit: OwnedSemaphorePermit) -> Self {
        Self { permit }
    }

    /// Release the permit back to the semaphore immediately.
    /// Normally this happens automatically when the BytePermit is dropped,
    /// but explicit release allows early release before the message is fully processed.
    pub fn release(self) {
        // Dropped = released via OwnedSemaphorePermit::drop
    }
}

/// Byte-capacity gate that enforces a hard limit on total bytes
/// "in-flight" through the channel (queued but not yet consumed).
///
/// Usage:
/// 1. Reader calls `acquire(bytes).await` before sending a batch
/// 2. Writer receives the message and the attached `BytePermit`
/// 3. When the writer drops the `BytePermit`, bytes are freed
#[derive(Clone)]
pub struct ByteGate {
    sem: Arc<Semaphore>,
}

impl ByteGate {
    /// Create a new byte gate with the given capacity in bytes.
    pub fn new(byte_capacity: usize) -> Self {
        Self {
            sem: Arc::new(Semaphore::new(byte_capacity)),
        }
    }

    /// Acquire permits for the given number of bytes.
    /// Blocks if the channel's byte capacity is exhausted.
    pub async fn acquire(&self, bytes: usize) -> Result<BytePermit, tokio::sync::AcquireError> {
        let permits = bytes.min(u32::MAX as usize) as u32;
        let permit = self.sem.clone().acquire_many_owned(permits).await?;
        Ok(BytePermit::new(permit))
    }

    /// Try to acquire permits without blocking.
    pub fn try_acquire(&self, bytes: usize) -> Result<BytePermit, tokio::sync::TryAcquireError> {
        let permits = bytes.min(u32::MAX as usize) as u32;
        let permit = self.sem.clone().try_acquire_many_owned(permits)?;
        Ok(BytePermit::new(permit))
    }
}

/// Estimate memory usage of a batch of JSON rows, including Rust metadata overhead.
pub fn estimate_batch_bytes(rows: &[Vec<serde_json::Value>]) -> u64 {
    let mut total = 0u64;
    for row in rows {
        // Vec overhead
        total += 24;
        for v in row {
            // serde_json::Value enum + String/Number overhead
            total += 32 + estimate_value_bytes(v);
        }
    }
    total
}

fn estimate_value_bytes(v: &serde_json::Value) -> u64 {
    match v {
        serde_json::Value::Null => 4,
        serde_json::Value::Bool(_) => 1,
        serde_json::Value::Number(n) => n.to_string().len() as u64,
        serde_json::Value::String(s) => s.len() as u64,
        _ => v.to_string().len() as u64,
    }
}

/// Estimate memory usage of a batch of native MigrationRows, including Rust metadata overhead.
pub fn estimate_native_batch_bytes(
    rows: &[crate::migration::native_row::MigrationRow],
) -> u64 {
    let mut total = 0u64;
    for row in rows {
        total += 24; // Vec overhead
        for v in &row.values {
            // Approx 32 bytes for MigrationValue enum and nested field overheads
            total += 32 + v.estimated_sql_size() as u64;
        }
    }
    total
}
