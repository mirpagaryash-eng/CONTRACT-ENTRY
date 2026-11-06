import { createApp } from './app.js';
const port = Number(process.env.PORT || 3001);
const app = createApp();
app.server.listen(port, '0.0.0.0', () => console.log(`Hisab is running on port ${port}. Data is stored in SQLite. WhatsApp is connected only when provider settings are supplied.`));
for (const signal of ['SIGTERM','SIGINT']) process.once(signal, async () => { await app.close(); process.exit(0); });
