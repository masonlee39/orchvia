# TDD-0059: A sweep's time, an application's processes, and retiring a confirmed dispatch

Specification: [SPEC-0059](../specs/0059-sweep-time-and-retirement.md).

- Reproduction, three runs of one script on 0.1.30, with a dispatch that has a stray and a clean one, and `timeoutMs` 6000: the stale check took 0.8 to 1.0 seconds and found the clean dispatch stopped; the sweep took 6.0 seconds, and again 6.0 on a second call, and reported the clean dispatch `unlisted`.
- RED, 6 of 7 tests: T01, the clean dispatches `unlisted`; T02 and T03, the sweep took its sixty seconds; A01, no `sortStrays`; R01 and both R02, the option did not exist. The seventh, a stray that exits during the wait, describes what the sweep already did, and passed.
- GREEN, 7 of 7. The same script then: the first sweep 4.0 seconds, the second 0.4 seconds, the clean dispatch proven in both.
- Mutations, each restored from a copy, each failing its test: no bound on the wait (T02); waiting at every sweep (T03); the wait back inside the first pass (T01); an attested acknowledgement that does not list holders, and one that does not check the instance (R02); the application rule only for applications from before the dispatch (A01).
- Not tested: the share of time per dispatch in the first pass. It matters only when a listing itself is slow, which no fixture produces; the test of T01 holds because nothing waits in that pass.
- Under load, six copies of the five stop marker test files beside one busy loop per core: `0036-Y01` failed in four copies while it waited ten seconds for its fixture's command to start, which the added tests' processes made slower. Its wait is now sixty seconds; the six copies then passed.
