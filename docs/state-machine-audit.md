# State machine audit

This audit covers every value in `ConversationStates` and the concrete caller, terminal intent, or reserved scope for each transition.

| State | Outgoing transition or terminal decision | Audit conclusion |
| --- | --- | --- |
| `IDLE` | `START_BROWSING → BROWSING` | Active entry state; `handleMessage` calls this when catalog browsing starts. |
| `BROWSING` | `ADD_TO_CART → CART`, `CANCEL → CANCELLED` | Active state with customer-driven exits. |
| `CART` | `ADD_TO_CART → CART`, `REVIEW_CART → CONFIRMING`, `CANCEL → CANCELLED` | Active state; the self-loop supports multiple items and the other events leave the cart. |
| `CONFIRMING` | `CONFIRM_ORDER → AWAITING_PAYMENT`, `CANCEL → CANCELLED` | Active state with explicit confirm/cancel exits. |
| `AWAITING_PAYMENT` | `PAYMENT_CONFIRMED → PAID`, `PAYMENT_EXPIRED → EXPIRED`, `CANCEL → CANCELLED` | Active state. Staff confirmation, the expiry runner, and customer cancellation now exercise all three exits. |
| `PAID` | Table contains `COMPLETE → DONE`, but no current caller emits `COMPLETE`. | **Operational terminal for the current bill/payment bot scope.** Fulfilment and delivery tracking are intentionally out of scope. The transition is reserved for a future fulfilment workflow rather than being invoked implicitly. |
| `DONE` | None. | Intentional final state reserved for a future workflow that explicitly completes a paid order. It is not expected to be reached in the current scope because `PAID` is the effective endpoint. |
| `CANCELLED` | None. | Intentional final state; a cancelled order cannot resume. A customer must start a new order. |
| `EXPIRED` | None. | Intentional final state; an expired payment session cannot resume. A customer must place a new order. |

## Decision on `PAID` and `DONE`

The bot's current responsibility ends when payment is manually confirmed. Therefore `PAID` is treated as the practical terminal state even though the transition table preserves `COMPLETE → DONE` for future fulfilment tracking. No completion menu or automatic completion is added in Phase 4. When fulfilment enters scope, it must gain an explicit authorized entry point and tests before `DONE` becomes reachable.

There are no accidental non-terminal dead ends in the current workflow: every active pre-payment state has a concrete exit, and all states without a current exit are documented terminal decisions.
