export async function register() {
  // Next.js will call this once for each server instance. We lazily import the
  // Node-specific registration code so the client bundle never sees the OTel SDK.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerObservability } = await import("./src/observability/register");
    await registerObservability();
  }
}
