// Backward-compatible alias for early V1 clients. The canonical endpoint is
// /operation-batches because the protocol commits an atomic batch.
export { POST } from "../operation-batches/route";
