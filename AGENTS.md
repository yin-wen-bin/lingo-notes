# Lingo Notes contributor guide

Read README.md, IMPLEMENTATION_PLAN.md, COORDINATION.md and docs/cloud-v1-contract.md before changing code. This repository contains the current cloud product only: Chrome extension, Supabase, DeepSeek and PWA. Do not add the retired local bridge, Pages or WorkBuddy implementation.

Never commit learning data, screenshots of personal content, credentials, generated packages or private runtime configuration. Use synthetic records for tests. Keep account isolation, explicit upload confirmation, cancellation and idempotency behavior intact.

Run npm test, npm run typecheck and npm run build -- --allow-unconfigured. Keep synthetic tests, real browser/platform checks, scheduled phone delivery and the seven-day trial distinct in reports. Do not silently call paid APIs, publish, or change production data during tests.

Third-party fonts and the pronunciation image retain their separate licensing status. MIT applies to project code, not those assets. All cloud deployment and review-account credentials stay outside Git.
