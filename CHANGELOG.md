# Changelog

## [0.0.15](https://github.com/KingTimer12/agnes-rs/compare/v0.0.14...v0.0.15) (2026-10-20)


### Features

* client-side default(fn) for generated column values ([2d57811](https://github.com/KingTimer12/agnes-rs/commit/2d57811c0af047a9c3a75cfab9e23a68c144cb65))
* count() and exists() terminals on the select builder ([853d688](https://github.com/KingTimer12/agnes-rs/commit/853d6880f50082dca148c28f989d4ee22b534081))
* latency-aware read routing as a tiebreaker within load buckets ([7340276](https://github.com/KingTimer12/agnes-rs/commit/73402762e9f5f72d1541e106edaecff515dcbd59))
* soft deletes via a .softDelete() marker column ([e58f399](https://github.com/KingTimer12/agnes-rs/commit/e58f3992237b00cb4299cf988c17f2fa32fadf73))


### Bug Fixes

* **ci:** build linux x86_64 wheels for every Python version ([a135cc9](https://github.com/KingTimer12/agnes-rs/commit/a135cc926b3fbe62680e7bd4da688878f6c4e921))
* lint problem ([5430a94](https://github.com/KingTimer12/agnes-rs/commit/5430a948eab98d3ab9bd1bd0845772b60f117953))
* pin the correct agnes-bridge version in the published library ([1b130ef](https://github.com/KingTimer12/agnes-rs/commit/1b130ef03acd7eaacac7242c41e7c332da7580ab))


### Performance Improvements

* base64-encode binary columns and preallocate row maps ([2c05bec](https://github.com/KingTimer12/agnes-rs/commit/2c05bec171cd038a48c2f294724dcfefa87985d5))

## [0.0.14](https://github.com/KingTimer12/agnes-rs/compare/v0.0.13...v0.0.14) (2026-07-08)


### Features

* freshRead() for read-your-writes on the master ([53d58c5](https://github.com/KingTimer12/agnes-rs/commit/53d58c5389ecefaf3d3e9e3231f05dc8102ba890))
* master/replica read-write splitting with load-aware routing ([419289a](https://github.com/KingTimer12/agnes-rs/commit/419289a41078cb2ff2d6baa9cdae969e46f506eb))
* pagination with offset() and page() ([e26975f](https://github.com/KingTimer12/agnes-rs/commit/e26975f130e491f269dcb88a0aa21e7726e40617))


### Bug Fixes

* lint problem ([87796d9](https://github.com/KingTimer12/agnes-rs/commit/87796d922d0b531a4399047e04505ba71f8aedfa))

## [0.0.13](https://github.com/KingTimer12/agnes-rs/compare/v0.0.12...v0.0.13) (2026-07-08)


### Features

* select().from() projection with .omit() column exclusion ([2ef0aab](https://github.com/KingTimer12/agnes-rs/commit/2ef0aab7919c6f0c7f5fb8d9fd1d14c856102dfc))
* type grouped columns in aggregate() results ([93e745e](https://github.com/KingTimer12/agnes-rs/commit/93e745eeb5a379dd1e9bac2319cfe58038e485a1))


### Performance Improvements

* memoize SQL parsing and drop per-param key allocations ([faf8209](https://github.com/KingTimer12/agnes-rs/commit/faf82098001f4bbfdc62b36213c5554b6879e834))

## [0.0.12](https://github.com/KingTimer12/agnes-rs/compare/v0.0.11...v0.0.12) (2026-07-07)


### Features

* bulk insert and upsert ([d2065a7](https://github.com/KingTimer12/agnes-rs/commit/d2065a7fc3d57de200619672c9a375ea03805a35))
* RETURNING support on insert/update/delete ([4ae17e4](https://github.com/KingTimer12/agnes-rs/commit/4ae17e4efe4354981f3da118d0a5a12c44e6d87e))
* richer query builder — condition tree + aggregations ([dd1c126](https://github.com/KingTimer12/agnes-rs/commit/dd1c1266f504ff7d5e5c889d9fab6feb766cc839))
* schema push — generate DDL and create tables ([86dbba0](https://github.com/KingTimer12/agnes-rs/commit/86dbba0c14427a4157737aa9b31ef12f7984c1df))
* streaming cursor for large result sets ([da9232d](https://github.com/KingTimer12/agnes-rs/commit/da9232d005e4084a5e982730a623bd3ac25a4f2b))

## [0.0.11](https://github.com/KingTimer12/agnes-rs/compare/v0.0.10...v0.0.11) (2026-07-06)


### Features

* configurable connection pool tuning ([4d2dfe7](https://github.com/KingTimer12/agnes-rs/commit/4d2dfe7669f30da2f1d36ea47afcfa5889037f70))

## [0.0.10](https://github.com/KingTimer12/agnes-rs/compare/v0.0.9...v0.0.10) (2026-07-06)


### Bug Fixes

* **postgres:** don't crash on undecodable column types ([233031f](https://github.com/KingTimer12/agnes-rs/commit/233031f8c425f65c2f4ba2cd8885e708ef2b313c))
