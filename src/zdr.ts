// Pi extension: asks OpenRouter to route every request to Zero Data Retention endpoints only.
// OpenRouter then refuses a model outright rather than send it to a provider that keeps data.
export function withZdr(payload: Record<string, any>): Record<string, any> {
  return { ...payload, provider: { ...payload.provider, zdr: true } };
}

export default function (pi: { on: (event: string, handler: (e: { payload: Record<string, any> }) => unknown) => void }) {
  pi.on("before_provider_request", (e) => withZdr(e.payload));
}
