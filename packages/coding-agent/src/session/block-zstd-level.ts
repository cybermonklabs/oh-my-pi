/**
 * zstd level of a block a session keeps compressed in memory: a block of older
 * entries' records, and a block of a rewrite's body where no spool file can be
 * made. Measured on two long transcripts: 17.2 MiB of records took 3.9 MiB,
 * 344.3 MiB took 65.7 MiB, and a read of one record (decompress its 1 MiB
 * block, slice it) 1.6 to 2.0 ms.
 */
export const BLOCK_ZSTD_LEVEL = 3;
