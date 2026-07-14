# State machine audit

This audit covers every value in `ConversationStates` and the concrete caller, terminal intent, or reserved scope for each transition.

| State | Outgoing transition or terminal decision | Audit conclusion |
| --- | --- | --- |
| `IDLE` | `START_BROWSING → BROWSING` | Active entry state; `handleMessage` calls this when catalog browsing starts. |
| `BROWSING` | `START_BROWSING → BROWSING`, `ADD_TO_CART → CART`, `CANCEL → CANCELLED` | Catalog refresh is idempotent and customer-driven exits remain explicit. |
| `CART` | `ADD_TO_CART → CART`, `REVIEW_CART → CONFIRMING`, `CANCEL → CANCELLED` | Active state; the self-loop supports multiple items and the other events leave the cart. |
| `CONFIRMING` | `ADD_TO_CART → CART`, `CONFIRM_ORDER → AWAITING_PAYMENT`, `CANCEL → CANCELLED` | A customer can return to the catalog and modify the cart before confirming. |
| `AWAITING_PAYMENT` | `PAYMENT_CONFIRMED → PAID`, `PAYMENT_EXPIRED → EXPIRED`, `CANCEL → CANCELLED` | Active state. Staff confirmation, the expiry runner, and customer cancellation now exercise all three exits. |
| `PAID` | `COMPLETE → DONE`, `START_NEW_ORDER → BROWSING` | The paid order remains immutable while the customer can open a clean shopping session. |
| `DONE` | `START_NEW_ORDER → BROWSING` | Completed orders stay final; only conversation context is reset. |
| `CANCELLED` | `START_NEW_ORDER → BROWSING` | The cancelled order does not resume; a fresh context starts another order. |
| `EXPIRED` | `START_NEW_ORDER → BROWSING` | The expired order does not resume; a fresh context starts another order. |

## Decision on order state and conversation reuse

The bot's current responsibility for an order ends when payment is manually confirmed. `COMPLETE → DONE` remains reserved for a future authorized fulfilment workflow. `START_NEW_ORDER` does not mutate the previous order: the service writes a fresh `{ "cart": [] }` conversation context and opens catalog browsing for the next order.

Payment confirmation and expiry use `Orders.status` as their source of truth. Conversation state advances only if it still references the resolved order, preventing UI navigation from invalidating a legitimate staff payment action. There are no customer-facing dead ends: active states provide contextual guidance and resolved states can begin a clean session.
