import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import { verifyRequest } from '../auth';

export async function me(
  req: HttpRequest,
  _ctx: InvocationContext,
): Promise<HttpResponseInit> {
  const { user, reason } = await verifyRequest(req);
  if (!user) {
    return {
      status: 200,
      jsonBody: { authenticated: false, reason },
    };
  }
  return {
    status: 200,
    jsonBody: {
      authenticated: true,
      userId: user.userId,
      userDetails: user.userDetails,
      identityProvider: 'msa',
      userRoles: ['owner'],
    },
  };
}

app.http('me', {
  route: 'me',
  methods: ['GET'],
  authLevel: 'anonymous',
  handler: me,
});
