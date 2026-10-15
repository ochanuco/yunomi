/** Cloudflare Access の Service Token。Tunnel の向こうの器官を呼ぶときに付ける。 */
export type AccessCredentials = { clientId: string; clientSecret: string };

export const accessHeaders = (
	c: AccessCredentials,
): Record<string, string> => ({
	"cf-access-client-id": c.clientId,
	"cf-access-client-secret": c.clientSecret,
});
