import { checkWhatsAppSender } from '../server/whatsapp-check.js';

const result = await checkWhatsAppSender(process.env);
// The checker returns only sanitized metadata, never credentials or raw API output.
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.ok ? 0 : result.kind === 'configuration' ? 2 : 1;
