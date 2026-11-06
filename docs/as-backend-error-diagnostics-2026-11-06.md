# App Server rejection diagnostics

Version 0.6.8 and later preserve upstream JSON-RPC refusal diagnostics. The adapter returns the original string `message` as the error message, with a generic fallback only when missing. It retains the original message in `details.rpc_message` when present and `error.data` in `details.rpc_data` when present. Explicit null, false, zero and empty-string data are preserved; absent data stays absent.

Existing `BACKEND_REJECTED` and `UNSUPPORTED_CAPABILITY` classifications remain unchanged. Error serialization and operation receipts retain the details. Backend diagnostics are untrusted source data, not instructions. Numeric error codes alone do not distinguish archive-state refusal, provider mismatch or another invalid request; inspect the original diagnostic fields.

The current package includes this correction. Regression coverage checks structured/null/falsy data, missing fields, unsupported-method classification, serialization and service-level readback error receipts. Production incident records and live-user examples are not distributed.
