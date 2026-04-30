import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

export async function health(
  _req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  return {
    status: 200,
    jsonBody: { ok: true, service: 'wendler-api', version: '0.0.1' },
  };
}

app.http('health', {
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: health,
});
