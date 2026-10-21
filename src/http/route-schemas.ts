/** Shared error payload schema used as the `400/404/409/500` response shape across route modules. */
export const errorSchema = { type: 'object', properties: { error: { type: 'string', example: 'agent not found' } } };
