# GAS script-lock and network-call audit

The GAS runtime has one project-wide `LockService.getScriptLock()` rather than keyed locks. This
change keeps the current transaction boundaries intact and adds a direct `ErrorLogs` entry with
`stage: script_lock_timeout`, `waitMs`, and `timeoutMs` whenever acquisition fails. The timeout
logger deliberately does not use `SheetErrorLogRepository`, because that repository would try to
acquire the same unavailable lock.

## Network calls currently reachable while the script lock is held

- `OrderService.handleMessage`, `confirmPayment`, `expireOrder`, and `sendPaymentQr` execute inside
  the injected `withLock`. With the live `BotOrderRepository`, calls to `save`, `findById`,
  `findByCustomerId`, `findAwaitingPaymentOlderThan`, and `updateStatus` reach
  `BotOrderWebhookClient.call`, which performs `UrlFetchApp.fetch` to the POS.
- `PaymentConfirmation.gs`, `PaymentExpiry.gs`, and `PaymentQrDispatch.gs` inject the same global
  script lock into `OrderService`, so their POS reads/mutations inherit the condition above.
- The Telegram and Zalo GAS webhook adapters wrap message transactions in the same lock; their
  `OrderService` repository calls therefore hold it across POS fetches. Telegram/Zalo response
  delivery happens after the transaction and is not part of this critical section.
- `ZaloTokenManager` refreshes via `UrlFetchApp.fetch`, but it reads the refresh token while locked,
  releases the lock for the network call, then reacquires the lock to persist the rotated token.
  The fetch itself is not inside `withScriptLock`.
- Fast-path payment HTTP probes, Telegram sends, Zalo sends/ZBS sends, and Admin API gateway calls
  are not currently made from inside `SheetRepositorySupport.withScriptLock` at their direct call
  sites.

Moving POS I/O outside the transaction requires a separate consistency design and race tests; it is
not part of this instrumentation change. The two future options are shorter GAS critical sections
with explicit optimistic/idempotent writes, or migration of the Zalo path to per-customer stateful
infrastructure comparable to Telegram Fast Path.

## Sheet scaling signal

Customer and recent-update lookups use short-lived Script Cache entries only as hints and always
fall back to Sheets. Track the `Customers` row count operationally; at more than 2,000 data rows,
raise a migration warning and evaluate an indexed datastore rather than extending cache TTLs.
