/**
 * Unit tests run without .env.local: provide harmless placeholder values so
 * serverEnv() validates. No real keys, and no network access is needed –
 * provider tests inject fake clients.
 */
const defaults: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: "https://test-project.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_placeholder",
  SUPABASE_SECRET_KEY: "sb_secret_test_placeholder_value",
};
for (const [key, value] of Object.entries(defaults)) process.env[key] = value;
// Never use a real AI key in unit tests.
delete process.env.OPENAI_API_KEY;
process.env.FOLKE_AI_PROVIDER = "mock";
// Never call HubSpot from unit tests: the client tests inject a fake fetch.
delete process.env.HUBSPOT_SERVICE_KEY;
process.env.FOLKE_LEAD_ANALYSIS_AI = "off";
