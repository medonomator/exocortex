# Next-Gen Memory Architecture for AI Systems

Date: 2026-04-21
Status: Design / Research

---

## Part 1: Progressive Memory Techniques (beyond standard Buffer/Window/Summary/Vector)

### 7. Emotional Memory

Запоминать не только **что** сказал юзер, но **как**:

```
"Этот деплой ОПЯТЬ сломался!!!" → {frustration: 0.9, topic: deploy}
"Интересно, а как работает ISR?" → {curiosity: 0.8, topic: frontend}
```

При следующем разговоре про деплой - модель знает что это больная тема.
При вопросе про фронтенд - юзер в режиме исследования, давать больше деталей.

**Blocker:** embedding models не кодируют эмоции. Нужна отдельная emotion detection модель + отдельный слой.

### 8. Causal Memory (не "что было", а "почему")

Хранить причинно-следственные цепочки, не просто факты:

```
Факт: "Перешли с Redis на KeyDB"
Причина: "Redis лицензия стала проприетарной"
Следствие: "Нужно тестировать совместимость BullMQ"
```

Вопрос "можно ли использовать Redis Streams?" - causal memory поймёт связь с решением об уходе от Redis. Vector search просто найдёт похожие слова.

**Blocker:** LLM для extraction причинных цепочек. Текущие модели плохо различают корреляцию и причинность.

### 9. Multi-Agent Shared Memory с Ownership

Несколько агентов работают над одним проектом, каждый со своей экспертизой:

```
Agent-Backend: "API возвращает 500 при пустом body"
Agent-Frontend: "Форма отправляет пустой body если юзер нажал Enter"
→ Shared memory: это ОДНА проблема, видимая с двух сторон
```

**Blocker:** нет протокола синхронизации памяти между агентами.

### 10. Active Forgetting (Garbage Collector для памяти)

Человеческая память активно забывает. AI memory только накапливает. Нужен GC:

```
- Факт не retrieval-ся 90 дней          → decay confidence
- Факт противоречит 3+ новым фактам     → archive
- Факт из удалённого контекста           → hard delete
- Факт использовался 50+ раз            → promote to "core memory"
```

**Blocker:** нет feedback loop "was this recalled memory actually useful in the response?"

### 11. Memory Compression через Abstraction Levels

Не summary, а иерархия абстракций:

```
Level 0 (raw):      "21 апреля обсуждали ISR для Next.js lesson pages"
Level 1 (event):    "Оптимизировали SSR стратегию для MindForge"
Level 2 (pattern):  "Периодически улучшаем performance фронтенда"
Level 3 (identity): "Performance - приоритет в архитектурных решениях"
```

Casual вопрос → retrieval с Level 2-3. Конкретный debugging → drill down до Level 0.

**Blocker:** автоматическое построение иерархий. LLM суммаризирует flat, не строит consistent multi-level abstractions.

### 12. Temporal Reasoning Memory

Понимание временных паттернов, не просто timestamps:

```
"Каждый понедельник юзер спрашивает про деплой"     → weekly pattern
"Юзер обычно ломает prod в пятницу вечером"         → risk pattern
"После отпуска юзер забывает контекст проекта"      → context decay pattern
```

Модель адаптируется: в понедельник готовит контекст деплоя. После отпуска - recap.

**Blocker:** time-series analysis поверх memory events. Timestamp - просто metadata, никто не анализирует.

---

## Part 2: Required Tooling

| Инструмент | Разблокирует | Статус 2026 |
|-----------|-------------|-------------|
| Emotion-aware embeddings | Emotional Memory (#7) | Research only |
| Causal extraction LLM | Causal Memory (#8) | GPT-4o может, дорого и unreliable |
| Agent memory protocol | Multi-Agent Memory (#9) | Нет стандарта |
| Memory feedback loop | Active Forgetting (#10) | Нигде не реализовано |
| Hierarchical summarizer | Abstraction Levels (#11) | Не существует |
| Temporal pattern mining | Temporal Reasoning (#12) | Есть в DS, нет в LLM memory |

---

## Part 3: Архитектура - Cognitive Memory System (CMS)

Проектируем систему памяти по образу человеческой когнитивной архитектуры.

### Принцип

Человеческая память - не база данных. Это **активная система** которая:
- Consolidates (short-term → long-term с трансформацией)
- Abstracts (обобщает из конкретных эпизодов)
- Forgets (активно удаляет irrelevant)
- Associates (связывает across domains)
- Predicts (anticipates на основе паттернов)
- Weights emotionally (важное помнится лучше)

### Слои памяти

```
┌─────────────────────────────────────────────────────┐
│                  RETRIEVAL BUS                       │
│  (query → fan-out to all layers → rank → merge)     │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────┐  │
│  │  SENSORY    │  │   WORKING    │  │   META     │  │
│  │  BUFFER     │→→│   MEMORY     │  │   MEMORY   │  │
│  │             │  │              │  │            │  │
│  │ Raw input   │  │ Current ctx  │  │ Memory     │  │
│  │ Last 30s    │  │ Window of    │  │ about      │  │
│  │ Pre-filter  │  │ attention    │  │ memory     │  │
│  └─────────────┘  └──────┬───────┘  └────────────┘  │
│                          │                           │
│              ┌───────────▼───────────┐               │
│              │    CONSOLIDATION      │               │
│              │    ENGINE             │               │
│              │                       │               │
│              │  sleep-like process   │               │
│              │  runs async/cron      │               │
│              └───┬──────┬───────┬────┘               │
│                  │      │       │                     │
│         ┌────────▼┐  ┌──▼────┐  ┌▼──────────┐        │
│         │EPISODIC │  │SEMANT.│  │PROCEDURAL │        │
│         │ MEMORY  │  │MEMORY │  │  MEMORY   │        │
│         │         │  │       │  │           │        │
│         │ Events  │  │ Facts │  │ Patterns  │        │
│         │ Stories │  │ Graph │  │ How-tos   │        │
│         │ Context │  │ Rels  │  │ Workflows │        │
│         └────┬────┘  └───┬───┘  ��─────┬─────┘        │
│              │           │            │               │
│              └───────────┼────────────┘               │
│                          │                            │
│              ┌───────────▼───────────┐                │
│              │    ABSTRACTION        │                │
│              │    LADDER             │                │
│              │                       │                │
│              │  L0: raw facts        │                │
│              │  L1: events           │                │
│              │  L2: patterns         │                │
│              │  L3: identity/values  │                │
│              └───────────────────────┘                │
│                                                      │
├──────────────────────────────────────────────────────┤
│              FORGETTING ENGINE                        │
│  confidence decay / contradiction / GC               │
└──────────────────────────────────────────────────────┘
```

### Детали каждого компонента

#### 1. Sensory Buffer (TTL: 30 seconds)

Сырой поток входных данных до обработки.

```typescript
interface SensoryEvent {
  raw: string;                    // исходный текст
  source: 'user' | 'system' | 'agent' | 'webhook';
  timestamp: number;
  metadata: {
    emotion?: EmotionVector;      // detected emotion
    urgency?: number;             // 0-1
    topic_hint?: string[];        // fast keyword extraction
  };
}
```

Зачем отдельный слой: фильтрация шума ДО того как что-то попадёт в memory.
Пример: юзер написал "ааа" и удалил - sensory buffer отбросит, не засоряя память.

#### 2. Working Memory (context window - активный контекст)

То что модель "видит" прямо сейчас. Аналог RAM.

```typescript
interface WorkingMemory {
  // Прямой контекст (Window Memory)
  recentMessages: Message[];          // last N messages
  maxTokens: number;                  // token budget

  // Pulled from long-term (результаты retrieval)
  retrievedEpisodes: Episode[];       // relevant episodes
  retrievedFacts: Fact[];             // relevant facts
  retrievedProcedures: Procedure[];   // relevant how-tos

  // Active focus
  currentTopics: string[];            // что обсуждаем сейчас
  activeEntities: Entity[];           // о ком/чём говорим
  conversationGoal?: string;          // зачем юзер пришёл
}
```

#### 3. Episodic Memory (PostgreSQL + pgvector)

Конкретные события с контекстом. "Что произошло, когда, при каких обстоятельствах."

```sql
CREATE TABLE episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,

  -- Content
  summary TEXT NOT NULL,              -- "Обсуждали ISR для MindForge"
  full_context JSONB,                 -- raw messages if needed
  embedding vector(1536),             -- semantic search

  -- Temporal
  occurred_at TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER,

  -- Emotional coloring
  emotion_valence FLOAT DEFAULT 0,    -- -1 negative .. +1 positive
  emotion_arousal FLOAT DEFAULT 0,    -- 0 calm .. 1 intense
  importance FLOAT DEFAULT 0.5,       -- 0 trivial .. 1 critical

  -- Abstraction level
  abstraction_level INTEGER DEFAULT 0, -- 0=raw, 1=event, 2=pattern, 3=identity

  -- Memory lifecycle
  confidence FLOAT DEFAULT 1.0,       -- decays over time
  recall_count INTEGER DEFAULT 0,     -- how many times retrieved
  last_recalled_at TIMESTAMPTZ,
  consolidated_into UUID REFERENCES episodes(id), -- higher abstraction
  status VARCHAR(20) DEFAULT 'active' -- active/archived/forgotten

);

CREATE INDEX idx_episodes_embedding ON episodes
  USING hnsw (embedding vector_cosine_ops);
CREATE INDEX idx_episodes_user_time ON episodes (user_id, occurred_at DESC);
CREATE INDEX idx_episodes_confidence ON episodes (user_id, confidence DESC);
```

#### 4. Semantic Memory (Knowledge Graph - PostgreSQL)

Факты, сущности, связи. "Что я знаю как истину."

```sql
-- Уже есть в exocortex: kg_entities, kg_relations
-- Расширяем:

ALTER TABLE kg_entities ADD COLUMN IF NOT EXISTS
  confidence FLOAT DEFAULT 1.0;
ALTER TABLE kg_entities ADD COLUMN IF NOT EXISTS
  source_episode_id UUID;             -- откуда узнали
ALTER TABLE kg_entities ADD COLUMN IF NOT EXISTS
  last_confirmed_at TIMESTAMPTZ;      -- когда последний раз подтвердилось
ALTER TABLE kg_entities ADD COLUMN IF NOT EXISTS
  contradiction_count INTEGER DEFAULT 0;

-- Causal relations
ALTER TABLE kg_relations ADD COLUMN IF NOT EXISTS
  relation_type VARCHAR(50) DEFAULT 'related_to';
  -- types: related_to, caused_by, enables, contradicts, supersedes
```

#### 5. Procedural Memory (Qdrant collection)

Паттерны поведения, рецепты, workflow-ы. "Как делать."

```typescript
interface ProceduralMemory {
  id: string;
  pattern: string;         // "WHEN exec format error on server"
  action: string;          // "DO docker build --platform linux/amd64"
  confidence: number;      // сколько раз сработало
  verifiedCount: number;   // "5x verified"
  lastUsed: Date;
  context: string[];       // ["docker", "deploy", "arm64"]
  embedding: number[];     // для semantic retrieval
}
```

Уже есть зачатки в exocortex (PROCEDURAL MEMORY в hooks).

#### 6. Meta-Memory ("память о памяти")

Система знает свои сильные и слабые стороны:

```typescript
interface MetaMemory {
  // Что я часто забываю?
  frequentMisses: {
    topic: string;
    missCount: number;
    lastMiss: Date;
  }[];

  // Что я часто вспоминаю правильно?
  reliableTopics: string[];

  // Какой тип retrieval работает лучше для какого запроса?
  retrievalStats: {
    queryType: string;        // "factual" | "procedural" | "emotional"
    bestSource: string;       // "episodic" | "semantic" | "procedural"
    avgRelevance: number;
  }[];

  // User feedback signals
  corrections: {
    what: string;
    when: Date;
    pattern?: string;         // "I keep confusing X with Y"
  }[];
}
```

### Процессы

#### Consolidation Engine (async, cron-like)

Аналог сна - периодический процесс обработки накопленного:

```
┌──────────────────────────────────────────────────┐
│              CONSOLIDATION PIPELINE               │
│                                                   │
│  1. EXTRACT                                       │
│     Raw messages → structured episodes            │
│     "Обсуждали ISR" → Episode {topic, emotion,    │
│      entities, decisions}                         │
│                                                   │
│  2. RELATE                                        │
│     New episodes → find connections to existing   │
│     "ISR discussion" ←→ "SEO optimization goal"   │
│     Update knowledge graph                        │
│                                                   │
│  3. ABSTRACT                                      │
│     Cluster similar episodes → higher level       │
│     3x "fixed performance" → Pattern "performance │
│     is recurring concern"                         │
│                                                   │
│  4. DETECT CONTRADICTIONS                         │
│     New fact vs existing facts                    │
│     "Uses React" (jan) vs "Moved to Vue" (apr)   │
│     → flag, resolve, update                       │
│                                                   │
│  5. EXTRACT PROCEDURES                            │
│     Repeated action patterns → procedural memory  │
│     3x "docker build --platform linux/amd64"      │
│     → ProceduralMemory {verified: 3}              │
│                                                   │
│  6. DECAY & PRUNE                                 │
│     confidence *= decay_factor(days_since_recall)  │
│     if confidence < 0.1 → archive                 │
│     if contradicted 3x → remove                   │
└──────────────────────────────────────────────────┘
```

Schedule:
- **Micro-consolidation**: после каждого разговора (extract + relate)
- **Daily consolidation**: abstract + detect contradictions (cron 23:00)
- **Weekly consolidation**: decay + prune + extract procedures (cron Sun 20:00)

Это уже mapping на существующий exocortex cron!

#### Retrieval Bus (при каждом запросе)

```
User query: "Как мы решали проблему с деплоем?"
                    │
        ┌───────────┼───────────────┐
        │           │               │
        ▼           ▼               ▼
   ┌─────────┐ ┌─────────┐  ┌───────────┐
   │Episodic │ │Semantic │  │Procedural │
   │ Search  │ │ Graph   │  │  Search   │
   │         │ │ Traverse│  │           │
   │ vector  │ │ entity  │  │ pattern   │
   │ sim >   │ │ "deploy"│  │ match     │
   │  0.75   │ │ → rels  │  │ "deploy"  │
   └────┬────┘ └────┬────┘  └─────┬─────┘
        │           │              │
        ▼           ▼              ▼
   ┌──────────────────────────────────┐
   │         RANKER / MERGER          │
   │                                  │
   │  Score = w1*vector_sim           │
   │        + w2*recency              │
   │        + w3*importance           │
   │        + w4*emotional_match      │
   │        + w5*recall_frequency     │
   │                                  │
   │  Deduplicate overlapping results │
   │  Respect token budget            │
   │  Format for LLM context          │
   └──────────────────────────────────┘
                    │
                    ▼
            Working Memory
            (injected into prompt)
```

Ключевое отличие от простого vector search: **multi-signal ranking**.
Vector similarity - один из 5 сигналов, не единственный.

#### Forgetting Engine

```typescript
interface ForgettingPolicy {
  // Time-based decay
  decayFunction: 'exponential' | 'power_law';
  halfLife: number;              // days - confidence drops to 0.5

  // Usage-based survival
  recallBoost: number;           // +confidence when retrieved & used
  coreMemoryThreshold: number;   // recall_count above which = permanent

  // Contradiction-based removal
  contradictionThreshold: number; // N contradictions → archive

  // Explicit signals
  userDeletionPolicy: 'hard_delete' | 'archive';

  // Space budget
  maxEpisodesPerUser: number;
  maxFactsPerUser: number;
  pruneStrategy: 'lowest_confidence' | 'oldest_unused';
}

// Ebbinghaus forgetting curve adapted for AI
function calculateConfidence(
  initialConfidence: number,
  daysSinceLastRecall: number,
  recallCount: number,
  importance: number,
): number {
  // Power law decay (better fit than exponential for human memory)
  const stabilityFactor = Math.log(recallCount + 1) * importance;
  const decay = Math.pow(1 + daysSinceLastRecall / stabilityFactor, -0.5);
  return initialConfidence * decay;
}

// Example:
// importance=0.8, recalled 5x, 30 days ago → confidence 0.72 (still strong)
// importance=0.3, recalled 1x, 30 days ago → confidence 0.18 (fading)
// importance=0.3, recalled 0x, 90 days ago → confidence 0.05 (nearly forgotten)
```

### Storage Map

```
┌─────────────────────────────────────────────┐
│                  STORAGE                     │
│                                              │
│  PostgreSQL (mind-forge-db)                  │
│  ├── episodes          (episodic memory)     │
│  ├── kg_entities       (semantic memory)     │
│  ├── kg_relations      (semantic memory)     │
│  ├── memory_meta       (meta-memory)         │
│  └── forgetting_log    (audit trail)         │
│                                              │
│  Qdrant                                      │
│  ├── episodic-memory   (episode embeddings)  │
│  ├── procedural-memory (pattern embeddings)  │
│  └── facts             (fact embeddings)     │
│                                              │
│  Redis/KeyDB (ephemeral)                     │
│  ├── sensory-buffer:{user}  (TTL 30s)       │
│  └── working-memory:{session} (TTL 1h)      │
└─────────────────────────────────────────────┘
```

### API Interface

```typescript
interface CognitiveMemorySystem {
  // === WRITE ===
  // Sensory input - raw, pre-processing
  ingest(event: SensoryEvent): Promise<void>;

  // Explicit memory creation
  remember(memory: {
    content: string;
    type: 'episode' | 'fact' | 'procedure';
    importance?: number;
    emotion?: EmotionVector;
  }): Promise<string>; // returns memory ID

  // === READ ===
  // Multi-layer retrieval
  recall(query: string, options?: {
    layers?: ('episodic' | 'semantic' | 'procedural')[];
    timeRange?: { from: Date; to: Date };
    minConfidence?: number;
    maxResults?: number;
    includeAbstractions?: boolean; // return higher-level patterns too
  }): Promise<RecallResult>;

  // === LIFECYCLE ===
  // Feedback - was the recalled memory useful?
  feedback(memoryId: string, useful: boolean): Promise<void>;

  // Consolidation trigger
  consolidate(level: 'micro' | 'daily' | 'weekly'): Promise<ConsolidationReport>;

  // Forgetting
  forget(memoryId: string, reason: string): Promise<void>;
  decay(): Promise<ForgettingReport>; // run decay cycle

  // === META ===
  introspect(): Promise<{
    totalMemories: number;
    byType: Record<string, number>;
    avgConfidence: number;
    topTopics: string[];
    recentContradictions: Contradiction[];
    healthScore: number; // 0-1, how "clean" is the memory
  }>;
}
```

### Implementation Phases

```
Phase 1: Foundation (можно начать сейчас)
├── Extend existing kg_entities/kg_relations with confidence + timestamps
├── Add episodes table to PostgreSQL
├── Implement basic confidence decay (cron)
├── Retrieval bus: vector + graph + recency scoring
└── Estimated: 2-3 days

Phase 2: Consolidation (после Phase 1)
├── Micro-consolidation after each conversation
├── Entity/relation extraction from episodes (LLM)
├── Contradiction detection (embedding similarity + LLM verify)
├── Daily cron integration with existing observe-daily.sh
└── Estimated: 3-5 days

Phase 3: Abstraction (после Phase 2)
├── Abstraction ladder: cluster episodes → patterns → identity
├── Procedural memory extraction from repeated actions
├── Multi-level retrieval (query complexity → abstraction level)
└── Estimated: 5-7 days

Phase 4: Advanced (после Phase 3)
├── Emotional memory layer
├── Temporal pattern detection
├── Meta-memory and self-optimization
├── Predictive pre-fetch
├── Multi-agent shared memory protocol
└── Estimated: 2-3 weeks
```

### Отличие от существующих решений

| Система | Что делает | Чего не хватает |
|---------|-----------|----------------|
| LangChain Memory | Buffer/Window/Summary/Vector | Нет consolidation, forgetting, abstraction |
| Mem0 | Long-term memory for LLMs | Нет graph, нет abstraction levels, нет decay |
| MemGPT/Letta | Self-editing memory | Нет emotional layer, нет temporal patterns |
| Zep | Session memory + facts | Нет procedural memory, нет multi-signal ranking |
| **CMS (this)** | All of the above | Integrated cognitive architecture |

### Ключевая идея

Все существующие memory systems - это **хранилища с поиском**.
CMS - это **активная когнитивная система** которая:

1. Не просто хранит, а **трансформирует** (raw → episodes → patterns → identity)
2. Не просто ищет, а **ранжирует по 5+ сигналам** (similarity + recency + importance + emotion + frequency)
3. Не просто накапливает, а **забывает** (confidence decay + contradiction + GC)
4. Не просто отвечает, а **предсказывает** (temporal patterns + pre-fetch)
5. Не просто работает, а **рефлексирует** (meta-memory: что я забываю? где я ошибаюсь?)

Это не memory storage. Это **cognitive memory system** - ближайший аналог того, как работает человеческая долговременная память.
