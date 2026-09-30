// Generated from schemas/protocol.schema.json; SHA-256 fd7f346bcd1c37d6e274797d241eb74bfc10029a56a2096f67156e22f62a6e51. Do not edit.
export const protocolSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:agent-orch:protocol:2.0',
  title: 'Agent orchestration protocol 2.0',
  description:
    'Wire 2.0 models with store-bound writes, schema 3 persistence, and SPEC-0009 orchestration. Both languages use camelCase wire keys. Snapshot objects permit additive extensions; mutation inputs are closed.',
  $defs: {
    RuntimeSpec: {
      type: 'object',
      additionalProperties: false,
      required: ['provider', 'model'],
      properties: {
        provider: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        model: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
      },
    },
    TaskSpec: {
      type: 'object',
      additionalProperties: false,
      required: ['goal', 'runtime', 'acceptance'],
      properties: {
        goal: {
          type: 'string',
          minLength: 1,
          maxLength: 65536,
        },
        runtime: {
          $ref: '#/$defs/RuntimeSpec',
        },
        acceptance: {
          oneOf: [
            {
              type: 'object',
              additionalProperties: false,
              required: ['mode', 'criteria'],
              properties: {
                mode: {
                  const: 'human',
                },
                criteria: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 100,
                  items: {
                    type: 'string',
                    minLength: 1,
                    maxLength: 65536,
                  },
                },
              },
            },
            {
              type: 'object',
              additionalProperties: false,
              required: ['mode', 'ruleRefs'],
              properties: {
                mode: {
                  const: 'checks',
                },
                ruleRefs: {
                  type: 'array',
                  minItems: 1,
                  maxItems: 20,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['id', 'version'],
                    properties: {
                      id: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 128,
                      },
                      version: {
                        type: 'string',
                        minLength: 1,
                        maxLength: 128,
                      },
                    },
                  },
                },
                maxRepairs: {
                  type: 'integer',
                  minimum: 0,
                  maximum: 20,
                },
              },
            },
          ],
        },
        dependencyTaskIds: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'string',
            minLength: 1,
          },
        },
        parentTaskId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        writeScope: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        contextPlan: {
          $ref: '#/$defs/ContextPlan',
        },
        budget: {
          $ref: '#/$defs/MoneyBudget',
        },
        contextEstimate: {
          $ref: '#/$defs/ContextEstimate',
        },
        writePath: {
          type: 'string',
          minLength: 1,
          maxLength: 4096,
          description: 'An existing workspace path inside writeScope; requires writeScope.',
        },
        label: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          description: "The host's own filterable label, 1 to 256 UTF-8 bytes (SPEC-0027 L01).",
        },
        metadata: {
          type: 'object',
          description:
            "The host's own JSON object, at most 4096 bytes when encoded and 16 levels deep (SPEC-0027 L01).",
        },
      },
    },
    TaskStatus: {
      enum: [
        'queued',
        'running',
        'waiting_approval',
        'paused',
        'blocked',
        'completed',
        'failed',
        'cancelled',
        'waiting_dependency',
        'verifying',
      ],
    },
    TaskSnapshot: {
      type: 'object',
      required: [
        'id',
        'status',
        'revision',
        'sessionId',
        'spec',
        'artifactRefs',
        'result',
        'reason',
        'approvalId',
        'createdAt',
        'updatedAt',
      ],
      properties: {
        id: {
          type: 'string',
        },
        status: {
          $ref: '#/$defs/TaskStatus',
        },
        revision: {
          type: 'integer',
          minimum: 1,
        },
        sessionId: {
          type: 'string',
        },
        spec: {
          $ref: '#/$defs/TaskSpec',
        },
        artifactRefs: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
        result: {
          type: ['string', 'null'],
        },
        reason: {
          type: ['string', 'null'],
        },
        approvalId: {
          type: ['string', 'null'],
        },
        createdAt: {
          type: 'string',
          format: 'date-time',
        },
        updatedAt: {
          type: 'string',
          format: 'date-time',
        },
        retryIdentity: {
          $ref: '#/$defs/RetryIdentity',
        },
        rootTaskId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        writePaths: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 4096,
          },
          maxItems: 100,
        },
        verificationRules: {
          type: 'array',
          items: {
            $ref: '#/$defs/FrozenVerificationRule',
          },
          maxItems: 20,
        },
        verificationAttempts: {
          type: 'integer',
          minimum: 0,
        },
        routing: {
          $ref: '#/$defs/RoutingDecision',
        },
        kind: {
          enum: ['work', 'compaction'],
        },
        maintenanceOperationId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        revisionRequest: {
          type: 'object',
          properties: {
            approvalId: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
            },
            comment: {
              type: 'string',
              minLength: 1,
              maxLength: 16384,
            },
          },
          required: ['approvalId', 'comment'],
          additionalProperties: false,
        },
        dependencyResultsDelivered: {
          type: 'boolean',
        },
        blockedBy: {
          $ref: '#/$defs/TaskBlocker',
        },
        deliveredAt: {
          type: 'string',
          format: 'date-time',
          description:
            'The time the task last delivered a result: its latest review for human acceptance, or its completion when its checks passed (SPEC-0029 B01).',
        },
        pausedByClose: {
          type: 'object',
          description:
            'Present while the task stays paused by a close; wasRunning says whether the close interrupted its turn (SPEC-0029 D01).',
          properties: {
            operationId: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
            },
            wasRunning: {
              type: 'boolean',
            },
          },
          required: ['operationId', 'wasRunning'],
          additionalProperties: false,
        },
      },
    },
    TaskBlocker: {
      type: 'object',
      description:
        'Why a queued task, or one that waits for its dependencies, waits; computed when read (SPEC-0028 B01).',
      properties: {
        reason: {
          enum: [
            'scheduler_failed',
            'host_stopping',
            'capacity',
            'quarantine_capacity',
            'resource_cleanup',
            'execution_conflict',
            'storage',
            'session_busy',
            'write_conflict',
            'scheduling',
            'dependency',
          ],
        },
        taskIds: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
          },
        },
        sessionId: {
          type: 'string',
          minLength: 1,
        },
      },
      required: ['reason'],
      additionalProperties: false,
    },
    ApprovalRequest: {
      type: 'object',
      required: [
        'approvalId',
        'taskId',
        'purpose',
        'revision',
        'status',
        'target',
        'summary',
        'evidenceRefs',
        'expiresAt',
      ],
      properties: {
        approvalId: {
          type: 'string',
        },
        taskId: {
          type: 'string',
        },
        purpose: {
          enum: ['task_acceptance', 'runtime_permission'],
        },
        revision: {
          type: 'integer',
          minimum: 1,
        },
        status: {
          enum: ['pending', 'approved', 'denied', 'revised', 'expired', 'invalidated'],
        },
        target: {
          type: 'object',
          required: ['taskId', 'taskRevision', 'artifactRefs'],
          properties: {
            taskId: {
              type: 'string',
            },
            taskRevision: {
              type: 'integer',
              minimum: 1,
            },
            artifactRefs: {
              type: 'array',
              items: {
                type: 'string',
              },
            },
            sessionId: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
            },
            generation: {
              type: 'integer',
              minimum: 1,
            },
            dispatchId: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
            },
            providerSessionId: {
              type: ['string', 'null'],
            },
            providerTurnId: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
            },
            requestId: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
            },
            toolName: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
            },
            permission: {},
            requestDigest: {
              type: 'string',
              minLength: 1,
              maxLength: 64,
            },
          },
        },
        summary: {
          type: 'string',
        },
        evidenceRefs: {
          type: 'array',
          items: {
            type: 'string',
          },
        },
        expiresAt: {
          type: 'string',
          format: 'date-time',
        },
        comment: {
          type: 'string',
          minLength: 1,
          maxLength: 16384,
        },
      },
    },
    UsageRecordedData: {
      type: 'object',
      description:
        "Data in a durable usage.recorded event. Events written from SPEC-0028 E02 on also hold the token counts, the model and the root task; raw stays in the record, which usage.getRecord returns. storeId, sessionId and occurredAt are on the event envelope. From SPEC-0030 A03 on, the event also carries cacheWrite5mInputTokens and cacheWrite1hInputTokens when the record has them. model is the record's own model (SPEC-0031 B04).",
      required: ['usageRecordId', 'dispatchId', 'provider'],
      properties: {
        usageRecordId: {
          type: 'string',
          minLength: 1,
          maxLength: 512,
        },
        dispatchId: {
          type: 'string',
          minLength: 1,
        },
        provider: {
          type: 'string',
          minLength: 1,
        },
        inputTokens: {
          type: ['integer', 'null'],
          minimum: 0,
          maximum: 9007199254740991,
        },
        cachedInputTokens: {
          type: ['integer', 'null'],
          minimum: 0,
          maximum: 9007199254740991,
        },
        cacheWriteInputTokens: {
          type: ['integer', 'null'],
          minimum: 0,
          maximum: 9007199254740991,
        },
        cacheWrite5mInputTokens: {
          type: 'integer',
          minimum: 0,
          maximum: 9007199254740991,
        },
        cacheWrite1hInputTokens: {
          type: 'integer',
          minimum: 0,
          maximum: 9007199254740991,
        },
        outputTokens: {
          type: ['integer', 'null'],
          minimum: 0,
          maximum: 9007199254740991,
        },
        model: {
          type: 'string',
          minLength: 1,
        },
        rootTaskId: {
          type: 'string',
          minLength: 1,
        },
      },
    },
    UsageRecord: {
      type: 'object',
      description:
        "Reported integer token counts or null when unknown. Raw provider JSON retains its original keys and is not synthesized into zero usage or cost. Records written from SPEC-0028 E01 on also hold sessionId, model, rootTaskId and recordedAt. A runtime that splits its cache writes by how long they live also reports cacheWrite5mInputTokens and cacheWrite1hInputTokens, which together are cacheWriteInputTokens (SPEC-0030 A03). model is the one the runtime named for the observation, else the dispatch session's; the Claude adapter reports the calls outside a dispatch's main loop, such as a compaction, as further records of their own models (SPEC-0031).",
      required: [
        'id',
        'taskId',
        'dispatchId',
        'provider',
        'inputTokens',
        'cachedInputTokens',
        'cacheWriteInputTokens',
        'outputTokens',
        'raw',
      ],
      properties: {
        id: {
          type: 'string',
        },
        taskId: {
          type: 'string',
        },
        dispatchId: {
          type: 'string',
        },
        provider: {
          type: 'string',
        },
        inputTokens: {
          type: ['integer', 'null'],
          minimum: 0,
          maximum: 9007199254740991,
        },
        cachedInputTokens: {
          type: ['integer', 'null'],
          minimum: 0,
          maximum: 9007199254740991,
        },
        cacheWriteInputTokens: {
          type: ['integer', 'null'],
          minimum: 0,
          maximum: 9007199254740991,
        },
        cacheWrite5mInputTokens: {
          type: 'integer',
          minimum: 0,
          maximum: 9007199254740991,
        },
        cacheWrite1hInputTokens: {
          type: 'integer',
          minimum: 0,
          maximum: 9007199254740991,
        },
        outputTokens: {
          type: ['integer', 'null'],
          minimum: 0,
          maximum: 9007199254740991,
        },
        raw: {},
        sessionId: {
          type: 'string',
          minLength: 1,
        },
        model: {
          type: 'string',
          minLength: 1,
        },
        rootTaskId: {
          type: 'string',
          minLength: 1,
        },
        recordedAt: {
          type: 'string',
          format: 'date-time',
        },
      },
    },
    UsageSummaryParams: {
      type: 'object',
      properties: {
        rootTaskId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
      },
      required: ['rootTaskId'],
      additionalProperties: false,
    },
    UsageTotals: {
      type: 'object',
      description:
        'Each count is the sum over the records that report it; unknownRecords lack an input or output count (SPEC-0028 P03). cacheWrite5mInputTokens and cacheWrite1hInputTokens sum the records that split their cache writes by duration; cacheWriteInputTokens minus both is the cache writes of the records without a split (SPEC-0030 A04).',
      properties: {
        records: {
          type: 'integer',
          minimum: 0,
          maximum: 9007199254740991,
        },
        inputTokens: {
          type: 'integer',
          minimum: 0,
          maximum: 9007199254740991,
        },
        cachedInputTokens: {
          type: 'integer',
          minimum: 0,
          maximum: 9007199254740991,
        },
        cacheWriteInputTokens: {
          type: 'integer',
          minimum: 0,
          maximum: 9007199254740991,
        },
        cacheWrite5mInputTokens: {
          type: 'integer',
          minimum: 0,
          maximum: 9007199254740991,
        },
        cacheWrite1hInputTokens: {
          type: 'integer',
          minimum: 0,
          maximum: 9007199254740991,
        },
        outputTokens: {
          type: 'integer',
          minimum: 0,
          maximum: 9007199254740991,
        },
        unknownRecords: {
          type: 'integer',
          minimum: 0,
          maximum: 9007199254740991,
        },
      },
      required: [
        'records',
        'inputTokens',
        'cachedInputTokens',
        'cacheWriteInputTokens',
        'cacheWrite5mInputTokens',
        'cacheWrite1hInputTokens',
        'outputTokens',
        'unknownRecords',
      ],
      additionalProperties: false,
    },
    UsageModelTotals: {
      type: 'object',
      description:
        "UsageTotals of one provider and model; model is null when neither the record nor its dispatch's session names it. The split of cache writes by duration is counted as in UsageTotals (SPEC-0030 A04).",
      properties: {
        provider: {
          type: 'string',
          minLength: 1,
        },
        model: {
          type: ['string', 'null'],
        },
        records: {
          type: 'integer',
          minimum: 0,
          maximum: 9007199254740991,
        },
        inputTokens: {
          type: 'integer',
          minimum: 0,
          maximum: 9007199254740991,
        },
        cachedInputTokens: {
          type: 'integer',
          minimum: 0,
          maximum: 9007199254740991,
        },
        cacheWriteInputTokens: {
          type: 'integer',
          minimum: 0,
          maximum: 9007199254740991,
        },
        cacheWrite5mInputTokens: {
          type: 'integer',
          minimum: 0,
          maximum: 9007199254740991,
        },
        cacheWrite1hInputTokens: {
          type: 'integer',
          minimum: 0,
          maximum: 9007199254740991,
        },
        outputTokens: {
          type: 'integer',
          minimum: 0,
          maximum: 9007199254740991,
        },
        unknownRecords: {
          type: 'integer',
          minimum: 0,
          maximum: 9007199254740991,
        },
      },
      required: [
        'provider',
        'model',
        'records',
        'inputTokens',
        'cachedInputTokens',
        'cacheWriteInputTokens',
        'cacheWrite5mInputTokens',
        'cacheWrite1hInputTokens',
        'outputTokens',
        'unknownRecords',
      ],
      additionalProperties: false,
    },
    UsageSummary: {
      type: 'object',
      description:
        'Token totals of a root task and every task whose rootTaskId names it (SPEC-0028 P03).',
      properties: {
        rootTaskId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        byModel: {
          type: 'array',
          items: {
            $ref: '#/$defs/UsageModelTotals',
          },
        },
        totals: {
          $ref: '#/$defs/UsageTotals',
        },
        completeness: {
          enum: ['reported', 'unknown'],
        },
      },
      required: ['rootTaskId', 'byModel', 'totals', 'completeness'],
      additionalProperties: false,
    },
    UsageByTaskParams: {
      type: 'object',
      description: '1 to 100 distinct task IDs (SPEC-0029 A01).',
      properties: {
        taskIds: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
          },
          minItems: 1,
          maxItems: 100,
        },
      },
      required: ['taskIds'],
      additionalProperties: false,
    },
    UsageTaskTotals: {
      type: 'object',
      description:
        "One task's own usage records per provider and model, as usage.summary counts them (SPEC-0029 A01).",
      properties: {
        taskId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        byModel: {
          type: 'array',
          items: {
            $ref: '#/$defs/UsageModelTotals',
          },
        },
        totals: {
          $ref: '#/$defs/UsageTotals',
        },
        completeness: {
          enum: ['reported', 'unknown'],
        },
        reasoningEfforts: {
          type: 'array',
          description:
            "The distinct efforts the task's records ran with, in first-recorded order (SPEC-0042 E05).",
          items: {
            type: 'string',
            minLength: 1,
          },
        },
      },
      required: ['taskId', 'byModel', 'totals', 'completeness', 'reasoningEfforts'],
      additionalProperties: false,
    },
    UsageByTaskResult: {
      type: 'object',
      description:
        'The tasks found and the IDs not found, each in the order requested (SPEC-0029 A01).',
      properties: {
        tasks: {
          type: 'array',
          items: {
            $ref: '#/$defs/UsageTaskTotals',
          },
          maxItems: 100,
        },
        missing: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
          },
          maxItems: 100,
        },
      },
      required: ['tasks', 'missing'],
      additionalProperties: false,
    },
    SessionStatus: {
      enum: ['idle', 'running', 'pausing', 'paused', 'closed', 'outcome_unknown'],
    },
    SessionSnapshot: {
      type: 'object',
      required: [
        'id',
        'taskId',
        'provider',
        'model',
        'providerSessionId',
        'generation',
        'revision',
        'status',
        'activeDispatchId',
      ],
      properties: {
        id: {
          type: 'string',
        },
        taskId: {
          type: ['string', 'null'],
        },
        provider: {
          type: 'string',
        },
        model: {
          type: 'string',
        },
        providerSessionId: {
          type: ['string', 'null'],
        },
        generation: {
          type: 'integer',
          minimum: 1,
        },
        revision: {
          type: 'integer',
          minimum: 1,
        },
        status: {
          $ref: '#/$defs/SessionStatus',
        },
        activeDispatchId: {
          type: ['string', 'null'],
        },
        pauseOrigin: {
          enum: ['client', 'runtime'],
          description:
            'Durable origin of a control pause. Absent legacy pauses cannot be resumed by a runtime tool.',
        },
        execution: {
          $ref: '#/$defs/SessionExecution',
        },
        retryIdentity: {
          $ref: '#/$defs/RetryIdentity',
        },
        taskIds: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
          },
          maxItems: 1000000,
        },
        rootTaskId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        permissionProfile: {
          enum: ['read-only', 'workspace-write'],
        },
        writePaths: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 4096,
          },
          maxItems: 100,
        },
        nativeCheckpoint: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        forkSource: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
            },
            generation: {
              type: 'integer',
              minimum: 1,
            },
            providerSessionId: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
            },
            nativeCheckpoint: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
            },
            snapshotRef: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
            },
          },
          required: [
            'sessionId',
            'generation',
            'providerSessionId',
            'nativeCheckpoint',
            'snapshotRef',
          ],
          additionalProperties: false,
        },
        generations: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              generation: {
                type: 'integer',
                minimum: 1,
              },
              providerSessionId: {
                type: ['string', 'null'],
              },
              nativeCheckpoint: {
                type: 'string',
                minLength: 1,
                maxLength: 128,
              },
              artifactRef: {
                type: 'string',
                minLength: 1,
                maxLength: 128,
              },
            },
            required: ['generation', 'providerSessionId', 'artifactRef'],
            additionalProperties: false,
          },
          maxItems: 1000000,
        },
        label: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          description: "The host's own filterable label, 1 to 256 UTF-8 bytes (SPEC-0027 L01).",
        },
        metadata: {
          type: 'object',
          description:
            "The host's own JSON object, at most 4096 bytes when encoded and 16 levels deep (SPEC-0027 L01).",
        },
      },
    },
    OperationStatus: {
      enum: ['persisted', 'completed', 'noop', 'rejected', 'failed', 'outcome_unknown'],
    },
    EngineLimits: {
      type: 'object',
      additionalProperties: false,
      description:
        'Owner-configured limits. maxActiveSessions accepts 1 through 8 (default 2); maxQuarantinedDispatches must be at least the effective maxActiveSessions.',
      properties: {
        maxActiveSessions: {
          type: 'integer',
          minimum: 1,
          maximum: 8,
          default: 2,
        },
        maxQuarantinedDispatches: {
          type: 'integer',
          minimum: 1,
          maximum: 1024,
          default: 32,
        },
        maxTurnsPerTask: {
          type: 'integer',
          minimum: 1,
          maximum: 1000,
          default: 20,
        },
        maxLogicalSessions: {
          type: 'integer',
          minimum: 1,
          maximum: 100000,
          default: 10000,
        },
        maxQueuedTasks: {
          type: 'integer',
          minimum: 1,
          maximum: 10000,
        },
        defaultMaxQueueWaitMs: {
          type: 'integer',
          minimum: 0,
          maximum: 604800000,
          default: 30000,
          description:
            'Queue wait of a task whose contextPlan does not set maxQueueWaitMs, resolved at admission. Only time spent queued counts (SPEC-0015).',
        },
      },
      allOf: [
        {
          if: {
            properties: {
              maxActiveSessions: {
                const: 2,
              },
            },
          },
          then: {
            properties: {
              maxQuarantinedDispatches: {
                minimum: 2,
              },
            },
          },
        },
        {
          if: {
            required: ['maxActiveSessions'],
            properties: {
              maxActiveSessions: {
                const: 3,
              },
            },
          },
          then: {
            properties: {
              maxQuarantinedDispatches: {
                minimum: 3,
              },
            },
          },
        },
        {
          if: {
            required: ['maxActiveSessions'],
            properties: {
              maxActiveSessions: {
                const: 4,
              },
            },
          },
          then: {
            properties: {
              maxQuarantinedDispatches: {
                minimum: 4,
              },
            },
          },
        },
        {
          if: {
            required: ['maxActiveSessions'],
            properties: {
              maxActiveSessions: {
                const: 5,
              },
            },
          },
          then: {
            properties: {
              maxQuarantinedDispatches: {
                minimum: 5,
              },
            },
          },
        },
        {
          if: {
            required: ['maxActiveSessions'],
            properties: {
              maxActiveSessions: {
                const: 6,
              },
            },
          },
          then: {
            properties: {
              maxQuarantinedDispatches: {
                minimum: 6,
              },
            },
          },
        },
        {
          if: {
            required: ['maxActiveSessions'],
            properties: {
              maxActiveSessions: {
                const: 7,
              },
            },
          },
          then: {
            properties: {
              maxQuarantinedDispatches: {
                minimum: 7,
              },
            },
          },
        },
        {
          if: {
            required: ['maxActiveSessions'],
            properties: {
              maxActiveSessions: {
                const: 8,
              },
            },
          },
          then: {
            properties: {
              maxQuarantinedDispatches: {
                minimum: 8,
              },
            },
          },
        },
      ],
    },
    LifecycleTimeouts: {
      type: 'object',
      additionalProperties: false,
      description: 'Owner-configured lifecycle deadlines, independent of SDK wait timeouts.',
      properties: {
        acceptanceMs: {
          type: 'integer',
          minimum: 1,
          maximum: 86400000,
          default: 30000,
        },
        turnMs: {
          type: 'integer',
          minimum: 1,
          maximum: 86400000,
          default: 1800000,
        },
        drainMs: {
          type: 'integer',
          minimum: 1,
          maximum: 86400000,
          default: 300000,
        },
        interruptMs: {
          type: 'integer',
          minimum: 1,
          maximum: 86400000,
          default: 30000,
        },
        reconcileMs: {
          type: 'integer',
          minimum: 1,
          maximum: 86400000,
          default: 60000,
        },
      },
    },
    LifecycleCapability: {
      type: 'object',
      required: ['version', 'reconcile', 'durableDeadlines'],
      properties: {
        version: {
          const: 1,
        },
        reconcile: {
          const: 'owner-attestation',
        },
        durableDeadlines: {
          const: true,
        },
      },
    },
    ExecutionIsolationCapability: {
      type: 'object',
      required: [
        'version',
        'resourceRelease',
        'schedulerStatus',
        'ownerConflictResolution',
        'budgetVersion',
      ],
      properties: {
        version: {
          const: 1,
        },
        resourceRelease: {
          const: true,
        },
        schedulerStatus: {
          const: true,
        },
        ownerConflictResolution: {
          const: true,
        },
        budgetVersion: {
          const: 2,
        },
      },
    },
    ExecutionLease: {
      type: 'object',
      required: ['version', 'status', 'acquiredAt'],
      properties: {
        version: {
          const: 1,
        },
        status: {
          enum: ['held', 'released'],
        },
        acquiredAt: {
          type: 'string',
          format: 'date-time',
        },
        releasedAt: {
          type: 'string',
          format: 'date-time',
        },
        releaseReason: {
          type: 'string',
        },
        releaseEvidenceRef: {
          type: 'string',
        },
      },
    },
    DispatchBudget: {
      type: 'object',
      description:
        'Serializable execution budget diagnostics. Monotonic remaining-time callbacks are internal and are not part of this wire model.',
      required: [
        'policyVersion',
        'enteredAt',
        'acceptanceDeadlineAt',
        'deadlineAt',
        'effectiveAcceptanceMs',
        'effectiveTurnMs',
        'acceptanceSource',
        'turnSource',
      ],
      properties: {
        policyVersion: {
          const: 2,
        },
        enteredAt: {
          type: 'string',
          format: 'date-time',
        },
        acceptanceDeadlineAt: {
          type: 'string',
          format: 'date-time',
        },
        deadlineAt: {
          type: 'string',
          format: 'date-time',
        },
        effectiveAcceptanceMs: {
          type: 'integer',
          minimum: 1,
          maximum: 86400000,
        },
        effectiveTurnMs: {
          type: 'integer',
          minimum: 1,
          maximum: 86400000,
        },
        acceptanceSource: {
          type: 'string',
        },
        turnSource: {
          type: 'string',
        },
      },
    },
    SessionExecution: {
      type: 'object',
      required: ['dispatchId', 'lease', 'quarantined', 'lastEvidence'],
      properties: {
        dispatchId: {
          type: 'string',
        },
        lease: {
          $ref: '#/$defs/ExecutionLease',
        },
        quarantined: {
          type: 'boolean',
        },
        lastEvidence: {
          type: 'string',
        },
        budget: {
          $ref: '#/$defs/DispatchBudget',
        },
      },
    },
    SchedulerSnapshot: {
      type: 'object',
      required: [
        'maxActiveSessions',
        'maxQuarantinedDispatches',
        'executionOccupied',
        'quarantined',
        'quarantineReserved',
        'canDispatch',
        'reasons',
        'occupants',
        'truncated',
        'openConflicts',
        'conflicts',
        'conflictsTruncated',
      ],
      properties: {
        maxActiveSessions: {
          type: 'integer',
          minimum: 1,
          maximum: 8,
        },
        maxQuarantinedDispatches: {
          type: 'integer',
          minimum: 1,
          maximum: 1024,
        },
        executionOccupied: {
          type: 'integer',
          minimum: 0,
        },
        quarantined: {
          type: 'integer',
          minimum: 0,
        },
        quarantineReserved: {
          type: 'integer',
          minimum: 0,
        },
        canDispatch: {
          type: 'boolean',
        },
        reasons: {
          type: 'array',
          description:
            "Current reasons include EXECUTION_CAPACITY_EXHAUSTED, QUARANTINE_CAPACITY_EXCEEDED, HOST_STOPPING, SCHEDULER_FAILED (with HOST_STOPPING, after an internal failure stopped the host), RESOURCE_CLEANUP_PENDING and EXECUTION_EVIDENCE_CONFLICT. Clients must tolerate additional reason strings. Counts come from persisted dispatches; reasons also reflect this host's shutdown and in-memory cleanup state.",
          items: {
            type: 'string',
          },
        },
        occupants: {
          type: 'array',
          maxItems: 16,
          items: {
            type: 'object',
            required: [
              'taskId',
              'sessionId',
              'dispatchId',
              'leaseStatus',
              'quarantined',
              'lastEvidence',
              'enteredAt',
            ],
            properties: {
              taskId: {
                type: 'string',
              },
              sessionId: {
                type: 'string',
              },
              dispatchId: {
                type: 'string',
              },
              leaseStatus: {
                enum: ['held', 'released'],
              },
              quarantined: {
                type: 'boolean',
              },
              lastEvidence: {
                type: 'string',
              },
              enteredAt: {
                type: 'string',
                format: 'date-time',
              },
            },
          },
        },
        truncated: {
          type: 'boolean',
        },
        openConflicts: {
          type: 'integer',
          minimum: 0,
        },
        conflicts: {
          type: 'array',
          maxItems: 16,
          items: {
            type: 'object',
            required: ['conflictId', 'revision', 'dispatchId'],
            properties: {
              conflictId: {
                type: 'string',
              },
              revision: {
                type: 'integer',
                minimum: 1,
              },
              dispatchId: {
                type: 'string',
              },
            },
          },
        },
        conflictsTruncated: {
          type: 'boolean',
        },
      },
    },
    ExecutionConflict: {
      type: 'object',
      required: [
        'id',
        'revision',
        'dispatchId',
        'sessionId',
        'taskId',
        'generation',
        'status',
        'releaseEvidenceRef',
        'conflictingEvidenceRef',
        'createdAt',
      ],
      properties: {
        id: {
          type: 'string',
        },
        revision: {
          type: 'integer',
          minimum: 1,
        },
        dispatchId: {
          type: 'string',
        },
        sessionId: {
          type: 'string',
        },
        taskId: {
          type: 'string',
        },
        generation: {
          type: 'integer',
          minimum: 1,
        },
        status: {
          enum: ['open', 'resolved'],
        },
        releaseEvidenceRef: {
          type: ['string', 'null'],
        },
        conflictingEvidenceRef: {
          type: 'string',
        },
        createdAt: {
          type: 'string',
          format: 'date-time',
        },
        resolution: {
          type: 'object',
          required: ['operationId', 'evidenceRef', 'occurredAt'],
          properties: {
            operationId: {
              type: 'string',
            },
            evidenceRef: {
              type: 'string',
            },
            occurredAt: {
              type: 'string',
              format: 'date-time',
            },
          },
        },
      },
    },
    SchedulerGetParams: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
    SchedulerGetConflictParams: {
      type: 'object',
      additionalProperties: false,
      required: ['conflictId'],
      properties: {
        conflictId: {
          type: 'string',
          minLength: 1,
        },
      },
    },
    SchedulerResolveConflictParams: {
      type: 'object',
      additionalProperties: false,
      description:
        'Owner-only resource conflict resolution. A successful request returns OperationSnapshot and does not resolve business outcome quarantine.',
      required: ['conflictId', 'expectedRevision', 'evidence', 'idempotencyKey', 'expectedStoreId'],
      properties: {
        conflictId: {
          type: 'string',
          minLength: 1,
        },
        expectedRevision: {
          type: 'integer',
          minimum: 1,
        },
        evidence: {
          allOf: [
            {
              $ref: '#/$defs/ReconcileEvidence',
            },
            {
              properties: {
                localResources: {
                  const: 'stopped',
                },
                remoteExecution: {
                  const: 'stopped',
                },
                outcome: {
                  enum: ['not_executed', 'completed', 'failed', 'interrupted', 'unknown'],
                },
              },
            },
          ],
        },
        idempotencyKey: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        expectedStoreId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        requestDigest: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
        },
      },
    },
    OperationLifecycle: {
      type: 'object',
      required: [
        'enteredAt',
        'deadlineAt',
        'policyVersion',
        'kind',
        'expectedGeneration',
        'expectedDispatchId',
        'mayHaveBeenSent',
        'lastEvidence',
      ],
      properties: {
        enteredAt: {
          type: 'string',
          format: 'date-time',
        },
        deadlineAt: {
          type: 'string',
          format: 'date-time',
        },
        policyVersion: {
          const: 1,
        },
        kind: {
          enum: ['drain', 'interrupt', 'reconcile', 'shutdown'],
        },
        expectedGeneration: {
          type: ['integer', 'null'],
          minimum: 1,
        },
        expectedDispatchId: {
          type: ['string', 'null'],
        },
        mayHaveBeenSent: {
          type: 'boolean',
        },
        lastEvidence: {
          type: 'string',
        },
        expiredAt: {
          type: 'string',
          format: 'date-time',
        },
      },
    },
    OperationSnapshot: {
      type: 'object',
      required: [
        'id',
        'method',
        'scope',
        'idempotencyKey',
        'status',
        'targetId',
        'result',
        'error',
      ],
      properties: {
        id: {
          type: 'string',
        },
        method: {
          type: 'string',
        },
        scope: {
          type: 'string',
        },
        idempotencyKey: {
          type: 'string',
        },
        status: {
          $ref: '#/$defs/OperationStatus',
        },
        targetId: {
          type: 'string',
        },
        result: {
          description:
            'Method-specific raw JSON with original camelCase keys. sessions.reconcile may report executionReleased, resolved, unobservedResourcesReconciled and resourceCleanup. A pending cleanup requires the owner to retry reconcile with the original target, evidence and key; reading or waiting on this operation does not execute cleanup.',
        },
        error: {
          oneOf: [
            {
              type: 'null',
            },
            {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: {
                  type: 'string',
                },
                message: {
                  type: 'string',
                },
                data: {
                  description:
                    "The details of the code, such as STEER_TURN_ENDED's dispatchId, turnOutcome and taskStatus (SPEC-0048 S04).",
                  type: 'object',
                },
              },
            },
          ],
        },
        lifecycle: {
          $ref: '#/$defs/OperationLifecycle',
        },
        resolution: {
          type: 'object',
          required: ['operationId', 'outcome', 'occurredAt'],
          properties: {
            operationId: {
              type: 'string',
            },
            outcome: {
              type: 'string',
            },
            occurredAt: {
              type: 'string',
              format: 'date-time',
            },
          },
        },
        retryIdentity: {
          $ref: '#/$defs/RetryIdentity',
        },
      },
    },
    ReconcileEvidence: {
      type: 'object',
      additionalProperties: false,
      description:
        'Named owner attestation, not independently observed adapter evidence. A completed attestation may leave out result when the dispatch recorded a runtime result, which the engine then uses (SPEC-0045 R01). Unknown values retain business quarantine. Execution resources may be released independently when both localResources and remoteExecution are stopped and the engine confirms no active handles or evidence conflict.',
      required: [
        'source',
        'summary',
        'localResources',
        'remoteExecution',
        'sideEffects',
        'outcome',
      ],
      properties: {
        source: {
          const: 'owner_attestation',
        },
        summary: {
          type: 'string',
          minLength: 1,
          maxLength: 65536,
        },
        localResources: {
          enum: ['stopped', 'unknown'],
        },
        remoteExecution: {
          enum: ['stopped', 'unknown'],
        },
        sideEffects: {
          enum: ['resolved', 'unknown'],
        },
        outcome: {
          enum: ['not_executed', 'completed', 'failed', 'interrupted', 'unknown', 'recorded'],
        },
        result: {
          type: 'string',
          maxLength: 524288,
        },
      },
      allOf: [
        {
          if: {
            properties: {
              outcome: {
                const: 'completed',
              },
            },
            required: ['outcome'],
          },
          then: {},
          else: {
            not: {
              required: ['result'],
            },
          },
        },
      ],
    },
    ReconcileParams: {
      type: 'object',
      additionalProperties: false,
      required: ['target', 'evidence', 'idempotencyKey', 'expectedStoreId'],
      properties: {
        target: {
          $ref: '#/$defs/ControlTarget',
        },
        evidence: {
          $ref: '#/$defs/ReconcileEvidence',
        },
        idempotencyKey: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        expectedStoreId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        requestDigest: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
        },
      },
    },
    ControlTarget: {
      type: 'object',
      additionalProperties: false,
      required: [
        'sessionId',
        'expectedGeneration',
        'expectedRevision',
        'expectedDispatchId',
        'expectedState',
      ],
      properties: {
        sessionId: {
          type: 'string',
          minLength: 1,
        },
        expectedGeneration: {
          type: 'integer',
          minimum: 1,
        },
        expectedRevision: {
          type: 'integer',
          minimum: 1,
        },
        expectedDispatchId: {
          type: ['string', 'null'],
        },
        expectedState: {
          $ref: '#/$defs/SessionStatus',
        },
      },
    },
    MessageSpec: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId', 'toSessionId', 'expectedGeneration', 'kind', 'summary'],
      properties: {
        taskId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        toSessionId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        expectedGeneration: {
          type: 'integer',
          minimum: 1,
        },
        kind: {
          enum: ['assignment', 'finding', 'result', 'question'],
        },
        summary: {
          type: 'string',
          minLength: 1,
          maxLength: 65536,
        },
        artifactRefs: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'string',
            minLength: 1,
          },
        },
        ttlMs: {
          type: 'integer',
          minimum: 1,
          maximum: 604800000,
        },
        replyToMessageId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
      },
    },
    MessageSnapshot: {
      type: 'object',
      description:
        'Persisted message output, including server identity and status. This intentionally does not allOf the strict input MessageSpec, which rejects server-added fields. control messages remain unsupported; use sessions.control.',
      required: [
        'id',
        'fromSessionId',
        'idempotencyKey',
        'status',
        'taskId',
        'toSessionId',
        'expectedGeneration',
        'kind',
        'summary',
      ],
      properties: {
        id: {
          type: 'string',
        },
        fromSessionId: {
          type: 'string',
        },
        idempotencyKey: {
          type: 'string',
        },
        status: {
          enum: [
            'persisted',
            'dispatching',
            'runtime_accepted',
            'completed',
            'failed',
            'outcome_unknown',
            'expired',
          ],
        },
        taskId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        toSessionId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        expectedGeneration: {
          type: 'integer',
          minimum: 1,
        },
        kind: {
          description:
            '`steer` records a line added to a running turn (SPEC-0048 S03); it is never delivered in a prompt.',
          enum: ['assignment', 'finding', 'result', 'question', 'steer'],
        },
        dispatchId: {
          description: 'For kind steer: the dispatch whose turn it was added to.',
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        summary: {
          type: 'string',
          minLength: 1,
          maxLength: 65536,
        },
        artifactRefs: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'string',
            minLength: 1,
          },
        },
        ttlMs: {
          type: 'integer',
          minimum: 1,
          maximum: 604800000,
        },
        replyToMessageId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        retryIdentity: {
          $ref: '#/$defs/RetryIdentity',
        },
        createdAt: {
          type: 'string',
          format: 'date-time',
        },
        expiresAt: {
          type: 'string',
          format: 'date-time',
        },
        hopCount: {
          type: 'integer',
          minimum: 1,
          maximum: 128,
        },
      },
    },
    Request: {
      type: 'object',
      additionalProperties: false,
      required: ['jsonrpc', 'id', 'method', 'params'],
      properties: {
        jsonrpc: {
          const: '2.0',
        },
        id: {
          type: ['string', 'integer'],
        },
        method: {
          type: 'string',
          minLength: 1,
        },
        params: {
          type: 'object',
        },
      },
    },
    EventEnvelope: {
      type: 'object',
      additionalProperties: false,
      required: [
        'eventId',
        'cursor',
        'storeId',
        'schemaVersion',
        'type',
        'taskId',
        'sessionId',
        'operationId',
        'occurredAt',
        'data',
      ],
      properties: {
        eventId: {
          type: 'string',
        },
        cursor: {
          type: 'string',
          pattern: '^[0-9]+$',
        },
        storeId: {
          type: 'string',
        },
        schemaVersion: {
          const: 1,
        },
        type: {
          type: 'string',
        },
        taskId: {
          type: ['string', 'null'],
        },
        sessionId: {
          type: ['string', 'null'],
        },
        operationId: {
          type: ['string', 'null'],
        },
        occurredAt: {
          type: 'string',
          format: 'date-time',
        },
        data: {
          type: 'object',
        },
      },
    },
    RetryIdentity: {
      type: 'object',
      properties: {
        storeId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        method: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        scope: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        idempotencyKey: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        digestVersion: {
          const: 1,
        },
        requestDigest: {
          type: 'string',
          pattern: '^[a-f0-9]{64}$',
        },
      },
      required: ['storeId', 'method', 'scope', 'idempotencyKey', 'digestVersion', 'requestDigest'],
      additionalProperties: false,
    },
    MoneyBudget: {
      type: 'object',
      properties: {
        currency: {
          type: 'string',
          minLength: 1,
          maxLength: 12,
        },
        maxCost: {
          type: 'string',
          pattern: '^[0-9]+(\\.[0-9]{1,18})?$',
        },
        reservePerDispatch: {
          type: 'string',
          pattern: '^[0-9]+(\\.[0-9]{1,18})?$',
        },
      },
      required: ['currency', 'maxCost', 'reservePerDispatch'],
      additionalProperties: false,
    },
    ContextRefCheck: {
      type: 'object',
      description:
        'SPEC-0020 result of context.checkRefs: whether task admission would accept each context reference at the time of the call. It never contains the content.',
      required: ['contextRefs'],
      properties: {
        contextRefs: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: {
            type: 'object',
            required: ['artifactRef', 'admissible'],
            properties: {
              artifactRef: {
                type: 'string',
                minLength: 1,
                maxLength: 128,
              },
              admissible: {
                type: 'boolean',
              },
              code: {
                enum: [
                  'ARTIFACT_TOO_LARGE',
                  'ARTIFACT_HISTORY_EXPIRED',
                  'ARTIFACT_CORRUPT',
                  'NOT_FOUND',
                  'ARTIFACT_UNREADABLE',
                ],
              },
              bytes: {
                type: 'integer',
                minimum: 0,
              },
            },
          },
        },
      },
    },
    ContextEstimate: {
      type: 'object',
      properties: {
        inputTokens: {
          type: 'integer',
          minimum: 0,
        },
        outputReserveTokens: {
          type: 'integer',
          minimum: 0,
        },
        toolReserveTokens: {
          type: 'integer',
          minimum: 0,
        },
      },
      required: ['inputTokens', 'outputReserveTokens', 'toolReserveTokens'],
      additionalProperties: false,
    },
    RoutingMode: {
      enum: ['continue', 'parallel_tools', 'reuse', 'fork', 'fresh'],
    },
    ContextPlan: {
      type: 'object',
      properties: {
        requestedMode: {
          $ref: '#/$defs/RoutingMode',
        },
        independent: {
          type: 'boolean',
        },
        dependencyTaskIds: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
          },
          maxItems: 100,
        },
        contextRefs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              artifactRef: {
                type: 'string',
                minLength: 1,
                maxLength: 128,
              },
              version: {
                const: 1,
              },
            },
            required: ['artifactRef', 'version'],
            additionalProperties: false,
          },
          maxItems: 20,
        },
        candidateSessionId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        snapshotRef: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        fallbackModes: {
          type: 'array',
          items: {
            $ref: '#/$defs/RoutingMode',
          },
          maxItems: 4,
        },
        maxQueueWaitMs: {
          type: 'integer',
          minimum: 0,
          maximum: 604800000,
        },
      },
      required: ['requestedMode', 'independent'],
      additionalProperties: false,
    },
    RoutingDecision: {
      type: 'object',
      properties: {
        policyVersion: {
          const: 1,
        },
        mode: {
          $ref: '#/$defs/RoutingMode',
        },
        candidateSessionId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        expectedGeneration: {
          type: 'integer',
          minimum: 1,
        },
        enqueuedAt: {
          type: 'string',
          format: 'date-time',
        },
        deadlineAt: {
          type: 'string',
          format: 'date-time',
        },
        maxQueueWaitMs: {
          type: 'integer',
          minimum: 0,
          maximum: 604800000,
        },
        fallbackModes: {
          type: 'array',
          items: {
            $ref: '#/$defs/RoutingMode',
          },
          maxItems: 4,
        },
        reasonCode: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        submittedAt: {
          type: 'string',
          format: 'date-time',
        },
        expiredAt: {
          type: 'string',
          format: 'date-time',
        },
      },
      required: [
        'policyVersion',
        'mode',
        'candidateSessionId',
        'expectedGeneration',
        'enqueuedAt',
        'deadlineAt',
        'maxQueueWaitMs',
        'fallbackModes',
        'reasonCode',
      ],
      additionalProperties: false,
    },
    RuleReference: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        version: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
      },
      required: ['id', 'version'],
      additionalProperties: false,
    },
    VerificationRule: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        version: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        argv: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 65536,
          },
          maxItems: 100,
          minItems: 1,
        },
        cwdRelative: {
          type: 'string',
          minLength: 1,
          maxLength: 4096,
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: 3600000,
        },
        permissionProfile: {
          enum: ['read-only', 'workspace-write'],
        },
        success: {
          type: 'object',
          properties: {
            exitCode: {
              type: 'integer',
              minimum: 0,
              maximum: 255,
            },
          },
          required: ['exitCode'],
          additionalProperties: false,
        },
        maxOutputBytes: {
          type: 'integer',
          minimum: 1,
          maximum: 262144,
        },
        baselinePaths: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 4096,
          },
          maxItems: 100,
        },
      },
      required: [
        'id',
        'version',
        'argv',
        'cwdRelative',
        'timeoutMs',
        'permissionProfile',
        'success',
      ],
      additionalProperties: false,
    },
    FrozenVerificationRule: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        version: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        argv: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 65536,
          },
          maxItems: 100,
          minItems: 1,
        },
        cwdRelative: {
          type: 'string',
          minLength: 1,
          maxLength: 4096,
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: 3600000,
        },
        permissionProfile: {
          enum: ['read-only', 'workspace-write'],
        },
        success: {
          type: 'object',
          properties: {
            exitCode: {
              type: 'integer',
              minimum: 0,
              maximum: 255,
            },
          },
          required: ['exitCode'],
          additionalProperties: false,
        },
        maxOutputBytes: {
          type: 'integer',
          minimum: 1,
          maximum: 262144,
        },
        baselinePaths: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 4096,
          },
          maxItems: 100,
        },
        digest: {
          type: 'string',
          pattern: '^[a-f0-9]{64}$',
        },
      },
      required: [
        'id',
        'version',
        'argv',
        'cwdRelative',
        'timeoutMs',
        'permissionProfile',
        'success',
        'digest',
      ],
      additionalProperties: false,
    },
    SessionOpenSpec: {
      type: 'object',
      properties: {
        runtime: {
          $ref: '#/$defs/RuntimeSpec',
        },
        writeScope: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        writePath: {
          type: 'string',
          minLength: 1,
          maxLength: 4096,
          description: 'An existing workspace path inside writeScope; requires writeScope.',
        },
        label: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          description: "The host's own filterable label, 1 to 256 UTF-8 bytes (SPEC-0027 L01).",
        },
        metadata: {
          type: 'object',
          description:
            "The host's own JSON object, at most 4096 bytes when encoded and 16 levels deep (SPEC-0027 L01).",
        },
      },
      required: ['runtime'],
      additionalProperties: false,
    },
    InitializeParams: {
      type: 'object',
      additionalProperties: false,
      required: ['protocolVersion', 'sdkVersion'],
      properties: {
        protocolVersion: {
          const: '2.0',
        },
        sdkVersion: {
          type: 'string',
        },
      },
    },
    InitializeResult: {
      type: 'object',
      properties: {
        protocolVersion: {
          const: '2.0',
        },
        engineVersion: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        schemaVersion: {
          const: 3,
        },
        instanceId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        storeId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        capabilities: {
          type: 'object',
          required: ['storeNamespaces'],
          properties: {
            storeNamespaces: {
              type: 'object',
              properties: {
                version: {
                  const: 1,
                },
                expectedStoreId: {
                  const: true,
                },
                digestVersion: {
                  const: 1,
                },
              },
              required: ['version'],
            },
            workflow: {
              $ref: '#/$defs/WorkflowCapability',
            },
            readOnly: {
              type: 'object',
              description:
                'A host that answers reads from a store opened read-only (SPEC-0027 R09).',
              properties: {
                version: {
                  const: 1,
                },
              },
              required: ['version'],
            },
          },
        },
      },
      required: [
        'protocolVersion',
        'engineVersion',
        'schemaVersion',
        'instanceId',
        'storeId',
        'capabilities',
      ],
    },
    Pricing: {
      type: 'object',
      properties: {
        provider: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        model: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        currency: {
          type: 'string',
          minLength: 1,
          maxLength: 12,
        },
        version: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        inputTokenMode: {
          enum: ['total', 'uncached'],
        },
        perMillion: {
          type: 'object',
          properties: {
            input: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
            },
            output: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
            },
            cacheRead: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
            },
            cacheWrite: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
            },
            cacheWrite5m: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
              description:
                'Cache writes that live five minutes; without it, cacheWrite (SPEC-0033 C02).',
            },
            cacheWrite1h: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
              description:
                'Cache writes that live one hour; without it, cacheWrite (SPEC-0033 C02).',
            },
          },
          required: ['input', 'output'],
          additionalProperties: false,
        },
      },
      required: ['provider', 'model', 'currency', 'version', 'inputTokenMode', 'perMillion'],
      additionalProperties: false,
    },
    RuntimeInspection: {
      type: 'object',
      properties: {
        status: {
          enum: ['found', 'not_found', 'unavailable', 'mismatch'],
        },
        execution: {
          const: 'unknown',
        },
        providerSessionId: {
          type: ['string', 'null'],
        },
        records: {
          type: 'array',
          items: {},
          maxItems: 64,
        },
        detail: {
          type: 'string',
        },
        target: {},
        truncated: {
          type: 'boolean',
        },
      },
      required: ['status', 'execution', 'providerSessionId', 'records', 'truncated', 'detail'],
    },
    StoragePolicy: {
      type: 'object',
      properties: {
        quotaBytes: {
          type: 'integer',
          minimum: 1,
        },
        minFreeBytes: {
          type: 'integer',
          minimum: 0,
        },
        emergencyBytes: {
          type: 'integer',
          minimum: 0,
        },
        maxRecords: {
          type: 'integer',
          minimum: 1,
        },
        settlementReserveRecords: {
          type: 'integer',
          minimum: 1,
        },
        maxSettlementPerTarget: {
          type: 'integer',
          minimum: 1,
        },
        eventDays: {
          type: 'integer',
          minimum: 30,
        },
        detailDays: {
          type: 'integer',
          minimum: 90,
        },
        usageDays: {
          type: 'integer',
          minimum: 180,
        },
      },
      required: [],
      additionalProperties: false,
    },
    SnapshotPage: {
      type: 'object',
      properties: {
        snapshotId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        storeId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        cursor: {
          type: 'string',
          pattern: '^[0-9]+$',
        },
        retentionFloorCursor: {
          type: 'string',
          pattern: '^[0-9]+$',
        },
        expiresAt: {
          type: 'string',
          format: 'date-time',
        },
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: {
                enum: ['tasks', 'sessions', 'approvals'],
              },
              value: {
                type: 'object',
              },
            },
            required: ['kind', 'value'],
            additionalProperties: false,
          },
          maxItems: 128,
        },
        nextOffset: {
          type: 'integer',
          minimum: 0,
        },
        done: {
          type: 'boolean',
        },
      },
      required: [
        'snapshotId',
        'storeId',
        'cursor',
        'retentionFloorCursor',
        'expiresAt',
        'items',
        'nextOffset',
        'done',
      ],
      additionalProperties: false,
    },
    TaskCreateParams: {
      type: 'object',
      properties: {
        spec: {
          $ref: '#/$defs/TaskSpec',
        },
        expectedStoreId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        idempotencyKey: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        requestDigest: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
        },
      },
      required: ['spec', 'expectedStoreId', 'idempotencyKey'],
      additionalProperties: false,
    },
    MessageSendParams: {
      type: 'object',
      properties: {
        spec: {
          $ref: '#/$defs/MessageSpec',
        },
        expectedStoreId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        idempotencyKey: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        requestDigest: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
        },
      },
      required: ['spec', 'expectedStoreId', 'idempotencyKey'],
      additionalProperties: false,
    },
    SessionOpenParams: {
      type: 'object',
      properties: {
        spec: {
          $ref: '#/$defs/SessionOpenSpec',
        },
        expectedStoreId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        idempotencyKey: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        requestDigest: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
        },
      },
      required: ['spec', 'expectedStoreId', 'idempotencyKey'],
      additionalProperties: false,
    },
    TaskMutationParams: {
      type: 'object',
      properties: {
        taskId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        expectedStoreId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        idempotencyKey: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        requestDigest: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
        },
      },
      required: ['taskId', 'expectedStoreId', 'idempotencyKey'],
      additionalProperties: false,
    },
    SessionSteerParams: {
      description: 'SPEC-0048 S01: adds text to the running turn of one dispatch.',
      type: 'object',
      properties: {
        target: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
            },
            expectedGeneration: {
              type: 'integer',
              minimum: 1,
            },
            expectedDispatchId: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
            },
            expectedRevision: {
              type: 'integer',
              minimum: 1,
            },
          },
          required: ['sessionId', 'expectedGeneration', 'expectedDispatchId'],
          additionalProperties: false,
        },
        text: {
          type: 'string',
          minLength: 1,
          maxLength: 16384,
        },
        expectedStoreId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        idempotencyKey: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
      },
      required: ['target', 'text', 'idempotencyKey'],
      additionalProperties: false,
    },
    SessionControlParams: {
      type: 'object',
      properties: {
        target: {
          $ref: '#/$defs/ControlTarget',
        },
        command: {
          type: 'object',
          properties: {
            action: {
              enum: ['pause', 'resume', 'stop'],
            },
            mode: {
              enum: ['drain', 'interrupt'],
            },
          },
          required: ['action'],
          additionalProperties: false,
        },
        expectedStoreId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        idempotencyKey: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        requestDigest: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
        },
      },
      required: ['target', 'command', 'expectedStoreId', 'idempotencyKey'],
      additionalProperties: false,
    },
    SessionForkParams: {
      type: 'object',
      properties: {
        target: {
          $ref: '#/$defs/ControlTarget',
        },
        snapshotRef: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        model: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        acknowledgeCacheLoss: {
          type: 'boolean',
        },
        expectedStoreId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        idempotencyKey: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        requestDigest: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
        },
      },
      required: ['target', 'snapshotRef', 'expectedStoreId', 'idempotencyKey'],
      additionalProperties: false,
    },
    SessionMutationParams: {
      type: 'object',
      properties: {
        target: {
          $ref: '#/$defs/ControlTarget',
        },
        expectedStoreId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        idempotencyKey: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        requestDigest: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
        },
      },
      required: ['target', 'expectedStoreId', 'idempotencyKey'],
      additionalProperties: false,
    },
    StoreRolloverParams: {
      type: 'object',
      properties: {
        expectedStoreId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        idempotencyKey: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        requestDigest: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
        },
      },
      required: ['expectedStoreId', 'idempotencyKey'],
      additionalProperties: false,
    },
    StoreImportParams: {
      type: 'object',
      properties: {
        backupId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        expectedStoreId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        idempotencyKey: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        requestDigest: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
        },
      },
      required: ['backupId', 'expectedStoreId', 'idempotencyKey'],
      additionalProperties: false,
    },
    HostShutdownParams: {
      type: 'object',
      description:
        'Owner only: the parameters of host.shutdown and host.shutdown.continue. pause closes as interrupt does and pauses the turns it interrupted with owner_shutdown (SPEC-0028 S01).',
      properties: {
        mode: {
          enum: ['drain', 'interrupt', 'pause'],
        },
        timeoutMs: {
          type: 'integer',
          minimum: 0,
          maximum: 3600000,
        },
        operationId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        expectedStoreId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        idempotencyKey: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        requestDigest: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
        },
      },
      required: ['expectedStoreId'],
      additionalProperties: false,
    },
    ApprovalDecisionParams: {
      type: 'object',
      properties: {
        approvalId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        decision: {
          type: 'object',
          properties: {
            choice: {
              enum: ['approve', 'deny', 'revise'],
            },
            expectedRevision: {
              type: 'integer',
              minimum: 1,
            },
            comment: {
              type: 'string',
              minLength: 1,
              maxLength: 16384,
            },
          },
          required: ['choice', 'expectedRevision'],
          additionalProperties: false,
          allOf: [
            {
              if: {
                properties: {
                  choice: {
                    const: 'revise',
                  },
                },
              },
              then: {
                required: ['comment'],
              },
            },
          ],
        },
        expectedStoreId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        idempotencyKey: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        requestDigest: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
        },
      },
      required: ['approvalId', 'decision', 'expectedStoreId', 'idempotencyKey'],
      additionalProperties: false,
    },
    TaskListParams: {
      type: 'object',
      properties: {
        parentTaskId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        sessionId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        label: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
          description: 'The tasks with this label (SPEC-0027 L03).',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
        },
        afterCursor: {
          type: 'string',
          pattern: '^[0-9]{1,19}$',
        },
        status: {
          type: 'array',
          items: {
            $ref: '#/$defs/TaskStatus',
          },
          minItems: 1,
          maxItems: 10,
          description:
            '1 to 10 distinct statuses; combinable with one of parentTaskId, sessionId and label (SPEC-0028 P01).',
        },
        order: {
          enum: ['asc', 'desc'],
          description:
            'desc starts with the newest task, and afterCursor continues with older ones (SPEC-0028 P01).',
        },
      },
      allOf: [
        {
          not: {
            required: ['parentTaskId', 'sessionId'],
          },
        },
        {
          not: {
            required: ['parentTaskId', 'label'],
          },
        },
        {
          not: {
            required: ['sessionId', 'label'],
          },
        },
      ],
      additionalProperties: false,
    },
    TaskListResult: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            $ref: '#/$defs/TaskSnapshot',
          },
          maxItems: 100,
        },
        nextCursor: {
          type: ['string', 'null'],
          pattern: '^[0-9]{1,19}$',
        },
      },
      required: ['tasks', 'nextCursor'],
      additionalProperties: false,
    },
    TaskGetManyParams: {
      type: 'object',
      description: '1 to 100 distinct task IDs (SPEC-0028 P02).',
      properties: {
        taskIds: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
          },
          minItems: 1,
          maxItems: 100,
        },
      },
      required: ['taskIds'],
      additionalProperties: false,
    },
    TaskGetManyResult: {
      type: 'object',
      description:
        'The tasks found and the IDs not found, each in the order requested (SPEC-0028 P02).',
      properties: {
        tasks: {
          type: 'array',
          items: {
            $ref: '#/$defs/TaskSnapshot',
          },
          maxItems: 100,
        },
        missing: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 128,
          },
          maxItems: 100,
        },
      },
      required: ['tasks', 'missing'],
      additionalProperties: false,
    },
    HandoffRequest: {
      type: 'object',
      description:
        "A model's request that the host hand work to a session outside its subtree. It grants nothing until resolved.",
      properties: {
        handoffId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        status: {
          enum: ['pending', 'accepted', 'rejected', 'expired', 'invalidated'],
        },
        revision: {
          type: 'integer',
          minimum: 1,
        },
        fromTaskId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        fromSessionId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        fromDispatchId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        fromGeneration: {
          type: 'integer',
          minimum: 1,
        },
        rootTaskId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        targetSessionId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        goal: {
          type: 'string',
          minLength: 1,
          maxLength: 16384,
        },
        contextRefs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              artifactRef: {
                type: 'string',
                minLength: 1,
                maxLength: 128,
              },
              version: {
                const: 1,
              },
            },
            required: ['artifactRef', 'version'],
            additionalProperties: false,
          },
          maxItems: 20,
        },
        createdAt: {
          type: 'string',
          format: 'date-time',
        },
        expiresAt: {
          type: 'string',
          format: 'date-time',
        },
        resolvedAt: {
          type: 'string',
          format: 'date-time',
        },
        taskId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        comment: {
          type: 'string',
          minLength: 1,
          maxLength: 16384,
        },
      },
      required: [
        'handoffId',
        'status',
        'revision',
        'fromTaskId',
        'fromSessionId',
        'fromDispatchId',
        'fromGeneration',
        'rootTaskId',
        'targetSessionId',
        'goal',
        'contextRefs',
        'createdAt',
        'expiresAt',
      ],
      additionalProperties: false,
    },
    HandoffGetParams: {
      type: 'object',
      properties: {
        handoffId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
      },
      required: ['handoffId'],
      additionalProperties: false,
    },
    HandoffListParams: {
      type: 'object',
      properties: {
        status: {
          enum: ['pending', 'accepted', 'rejected', 'expired', 'invalidated'],
        },
        targetSessionId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
        },
        afterCursor: {
          type: 'string',
          pattern: '^[0-9]{1,19}$',
        },
      },
      additionalProperties: false,
    },
    HandoffListResult: {
      type: 'object',
      properties: {
        handoffs: {
          type: 'array',
          items: {
            $ref: '#/$defs/HandoffRequest',
          },
          maxItems: 100,
        },
        nextCursor: {
          type: ['string', 'null'],
          pattern: '^[0-9]{1,19}$',
        },
      },
      required: ['handoffs', 'nextCursor'],
      additionalProperties: false,
    },
    HandoffResolveParams: {
      type: 'object',
      properties: {
        handoffId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        expectedRevision: {
          type: 'integer',
          minimum: 1,
        },
        outcome: {
          enum: ['accepted', 'rejected'],
        },
        taskId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        comment: {
          type: 'string',
          minLength: 1,
          maxLength: 16384,
        },
        expectedStoreId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        idempotencyKey: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        requestDigest: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
        },
      },
      required: ['handoffId', 'expectedRevision', 'outcome', 'expectedStoreId', 'idempotencyKey'],
      allOf: [
        {
          if: {
            properties: {
              outcome: {
                const: 'accepted',
              },
            },
          },
          then: {
            required: ['taskId'],
          },
        },
        {
          if: {
            properties: {
              outcome: {
                const: 'rejected',
              },
            },
          },
          then: {
            not: {
              required: ['taskId'],
            },
          },
        },
      ],
      additionalProperties: false,
    },
    RuleRegisterParams: {
      type: 'object',
      properties: {
        rule: {
          $ref: '#/$defs/VerificationRule',
        },
        expectedStoreId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        idempotencyKey: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        requestDigest: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
        },
      },
      required: ['rule', 'expectedStoreId', 'idempotencyKey'],
      additionalProperties: false,
    },
    RuleRetireParams: {
      type: 'object',
      description: 'Owner only: retires a rule registered at runtime (SPEC-0028 U01).',
      properties: {
        id: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        version: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        expectedStoreId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        idempotencyKey: {
          type: 'string',
          minLength: 1,
          maxLength: 256,
        },
        requestDigest: {
          type: 'string',
          minLength: 1,
          maxLength: 64,
        },
      },
      required: ['id', 'version', 'expectedStoreId', 'idempotencyKey'],
      additionalProperties: false,
    },
    RegisteredVerificationRule: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        version: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        argv: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 65536,
          },
          maxItems: 100,
          minItems: 1,
        },
        cwdRelative: {
          type: 'string',
          minLength: 1,
          maxLength: 4096,
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1,
          maximum: 3600000,
        },
        permissionProfile: {
          enum: ['read-only', 'workspace-write'],
        },
        success: {
          type: 'object',
          properties: {
            exitCode: {
              type: 'integer',
              minimum: 0,
              maximum: 255,
            },
          },
          required: ['exitCode'],
          additionalProperties: false,
        },
        maxOutputBytes: {
          type: 'integer',
          minimum: 1,
          maximum: 262144,
        },
        baselinePaths: {
          type: 'array',
          items: {
            type: 'string',
            minLength: 1,
            maxLength: 4096,
          },
          maxItems: 100,
        },
        digest: {
          type: 'string',
          pattern: '^[a-f0-9]{64}$',
        },
        source: {
          enum: ['config', 'runtime'],
        },
        retiredAt: {
          type: 'string',
          format: 'date-time',
          description:
            'Set on a retired rule, which rules.list returns only with includeRetired (SPEC-0028 U04).',
        },
      },
      required: [
        'id',
        'version',
        'argv',
        'cwdRelative',
        'timeoutMs',
        'permissionProfile',
        'success',
        'digest',
        'source',
      ],
      additionalProperties: false,
    },
    RuleListParams: {
      type: 'object',
      properties: {
        includeRetired: {
          type: 'boolean',
        },
      },
      additionalProperties: false,
    },
    RuleListResult: {
      type: 'object',
      properties: {
        rules: {
          type: 'array',
          items: {
            $ref: '#/$defs/RegisteredVerificationRule',
          },
        },
      },
      required: ['rules'],
      additionalProperties: false,
      description:
        'At most 1000 effective rules, followed by the retired ones when includeRetired was set (SPEC-0028 U04).',
    },
    WorkflowCapability: {
      type: 'object',
      description: 'SPEC-0014 host workflow controls a host supports.',
      properties: {
        version: {
          const: 1,
        },
        dependencyResults: {
          const: true,
        },
        revise: {
          const: true,
        },
        delegationApproval: {
          const: true,
        },
        handoffs: {
          const: true,
        },
        writePath: {
          const: true,
        },
        runtimeRules: {
          const: true,
        },
        taskList: {
          const: true,
        },
        contextCheck: {
          const: true,
        },
        labels: {
          const: true,
        },
        taskQueries: {
          const: true,
        },
        queueReasons: {
          const: true,
        },
        pauseClose: {
          const: true,
        },
        ruleRetirement: {
          const: true,
        },
        usageByTask: {
          const: true,
        },
        reasoningEfforts: {
          const: true,
        },
        reconcileRecordedResult: {
          const: true,
        },
        steer: {
          const: true,
        },
      },
      required: ['version'],
    },
    SteerTurnEndedData: {
      type: 'object',
      description:
        "The data of STEER_TURN_ENDED: the turn a steer targeted, how it ended, and its task's status (SPEC-0048, SPEC-0051 E01).",
      additionalProperties: false,
      required: ['dispatchId', 'turnOutcome', 'taskStatus'],
      properties: {
        dispatchId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
        turnOutcome: {
          enum: ['completed', 'interrupted', 'failed', 'unknown'],
        },
        taskStatus: {
          $ref: '#/$defs/TaskStatus',
        },
      },
    },
    CursorExpiredData: {
      type: 'object',
      description:
        'The data of CURSOR_EXPIRED: why the cursor can no longer be read, and where to resynchronize (SPEC-0027, SPEC-0051 E01).',
      additionalProperties: false,
      required: ['reason', 'retentionFloorCursor', 'lastCursor', 'currentStoreId'],
      properties: {
        reason: {
          enum: ['store_changed', 'below_retention_floor', 'ahead_of_store'],
        },
        retentionFloorCursor: {
          type: 'string',
          minLength: 1,
          maxLength: 32,
        },
        lastCursor: {
          type: 'string',
          minLength: 1,
          maxLength: 32,
        },
        currentStoreId: {
          type: 'string',
          minLength: 1,
          maxLength: 128,
        },
      },
    },
    StoreTooNewData: {
      type: 'object',
      description:
        'The data of STORE_TOO_NEW: the features of the store this engine does not know, and the engine versions that wrote them; `unreadable` holds a recorded value that is not a list of features (SPEC-0051 R02, E01).',
      additionalProperties: false,
      required: ['features'],
      properties: {
        features: {
          type: 'array',
          maxItems: 100,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'engineVersion'],
            properties: {
              name: {
                type: 'string',
                minLength: 1,
                maxLength: 128,
              },
              engineVersion: {
                type: 'string',
                minLength: 1,
                maxLength: 128,
              },
            },
          },
        },
        unreadable: {
          type: 'string',
          maxLength: 4096,
        },
      },
    },
  },
};
