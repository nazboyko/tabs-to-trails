---
title: A test post with every kind of block
published: true
---

This opening paragraph comes before any heading. It has a [link](https://example.com/page) and some *emphasis*.

## Why the cache was slow

The service answered in 840 ms on a good day. We measured it for 3 weeks, as shown below.

| Week | Median | p95 |
|------|--------|-----|
| 1    | 840 ms | 2.1 s |
| 2    | 610 ms | 1.4 s |
| 3    | 120 ms | 0.3 s |

The third week is after the fix.

## The fix

We moved the lookup out of the request path:

```ts
const cache = new Map<string, string>();
export function lookup(key: string) {
  return cache.get(key) ?? load(key);
}
```

That was the whole change.

## What we checked

- The cache size stays under 50 MB.
- Old entries expire after 10 minutes.
- [x] A restart starts with an empty cache.

## Everything we tried first

1. Bigger instances
2. A second region
3. Connection pooling
4. A CDN in front of the API
5. Compressing responses
6. Rewriting the slow query
7. Adding an index
8. Moving to a newer database version
9. Caching at the edge
10. Turning off debug logging

![screenshot](https://example.com/a.png)

![A chart of median latency falling from 840 ms to 120 ms over three weeks](https://example.com/b.png)

<!-- a comment that must not be read -->

### Empty heading

## Closing

> Measure first, then change one thing.

Thanks for reading. {% embed https://example.com %}
