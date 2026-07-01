use std::fs::{File, OpenOptions};
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use bincode::Options;

use crate::protocolo::WalRecord;

pub struct Wal {
    path: PathBuf,
    writer: BufWriter<File>,
    entries_written: u64,
}

impl Wal {
    pub fn open(path: impl AsRef<Path>) -> std::io::Result<Self> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            std::fs::create_dir_all(parent)?;
        }
        let file = OpenOptions::new()
            .create(true)
            .read(true)
            .append(true)
            .open(&path)?;
        Ok(Self {
            path,
            writer: BufWriter::new(file),
            entries_written: 0,
        })
    }

    pub fn append(&mut self, rec: &WalRecord) -> std::io::Result<()> {
        let bytes = encode(rec)?;
        let len = (bytes.len() as u32).to_le_bytes();
        self.writer.write_all(&len)?;
        self.writer.write_all(&bytes)?;
        self.writer.flush()?;
        self.entries_written += 1;
        Ok(())
    }

    pub fn entries_written(&self) -> u64 {
        self.entries_written
    }

    pub fn replay(&self) -> std::io::Result<Vec<WalRecord>> {
        let file = OpenOptions::new().read(true).open(&self.path)?;
        let mut reader = BufReader::new(file);
        let mut out = Vec::new();
        loop {
            let mut len_buf = [0u8; 4];
            match reader.read_exact(&mut len_buf) {
                Ok(()) => {}
                Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
                Err(e) => return Err(e),
            }
            let len = u32::from_le_bytes(len_buf) as usize;
            let mut data = vec![0u8; len];
            reader.read_exact(&mut data)?;
            match decode(&data) {
                Ok(r) => out.push(r),
                Err(_) => break,
            }
        }
        Ok(out)
    }

    pub fn rewrite(&mut self, records: &[WalRecord]) -> std::io::Result<()> {
        self.writer.flush()?;
        let tmp = self.path.with_extension("wal.tmp");
        {
            let f = OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&tmp)?;
            let mut w = BufWriter::new(f);
            for r in records {
                let bytes = encode(r)?;
                let len = (bytes.len() as u32).to_le_bytes();
                w.write_all(&len)?;
                w.write_all(&bytes)?;
            }
            w.flush()?;
        }
        std::fs::rename(&tmp, &self.path)?;
        let file = OpenOptions::new()
            .read(true)
            .append(true)
            .open(&self.path)?;
        self.writer = BufWriter::new(file);
        self.entries_written = records.len() as u64;
        Ok(())
    }

    pub fn size_bytes(&mut self) -> std::io::Result<u64> {
        self.writer.flush()?;
        let mut f = OpenOptions::new().read(true).open(&self.path)?;
        f.seek(SeekFrom::End(0))
    }
}

fn encode(rec: &WalRecord) -> std::io::Result<Vec<u8>> {
    bincode::DefaultOptions::new()
        .with_fixint_encoding()
        .serialize(rec)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

fn decode(bytes: &[u8]) -> std::io::Result<WalRecord> {
    bincode::DefaultOptions::new()
        .with_fixint_encoding()
        .deserialize(bytes)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}
