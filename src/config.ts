function getEnvVar(name: string): string {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

export const config = {
	botToken: getEnvVar("BOT_TOKEN"),
	clientId: getEnvVar("CLIENT_ID"),
	databaseUrl: getEnvVar("DATABASE_URL"),
};
