/**
 * @quantflow/domain — canonical shared contracts.
 *
 * Backend, frontend, flow-engine and research tooling all import from here.
 * Nothing in this package performs I/O, so it is safe in every environment.
 */
export * from "./provenance.js";
export * from "./quality.js";
export * from "./result.js";
export * from "./runtimeMode.js";
export * from "./freshness.js";
export * from "./pointInTime.js";
export * from "./marketTime.js";
