# Retrieval eval

Corpus 220 items, 52 labeled queries, 8 out-of-scope queries. Embedder `text-embedding-3-small`, HyDE and rerank on gpt-4o-mini.

| config | nDCG@10 | Recall@5 | MRR@10 | answered (pos) | abstained (neg) |
|---|---|---|---|---|---|
| lexical arm only | 0.033 | 0.026 | 0.038 | n/a | n/a |
| vector only | 0.898 | 0.920 | 0.915 | 19/52 | 8/8 |
| hybrid (RRF, all signals) | 0.898 | 0.920 | 0.915 | 19/52 | 8/8 |
| hybrid + HyDE | 0.901 | 0.921 | 0.931 | 22/52 | 8/8 |
| hybrid + rerank | 0.944 | 0.950 | 0.966 | 19/52 | 8/8 |
| hybrid + HyDE + rerank | 0.953 | 0.957 | 0.966 | 22/52 | 8/8 |

The lexical arm (`plainto_tsquery('simple')`, every word must match) returned anything for 2 of 52 labeled queries.

nDCG@10 by query kind:

| config | keyword (12) | paraphrase (20) | short (12) | multi (8) |
|---|---|---|---|---|
| lexical arm only | 0.061 | 0.000 | 0.083 | 0.000 |
| vector only | 0.987 | 0.877 | 0.826 | 0.928 |
| hybrid (RRF, all signals) | 0.987 | 0.877 | 0.826 | 0.928 |
| hybrid + HyDE | 0.987 | 0.877 | 0.840 | 0.928 |
| hybrid + rerank | 0.987 | 0.967 | 0.846 | 0.973 |
| hybrid + HyDE + rerank | 0.987 | 0.967 | 0.881 | 0.973 |
