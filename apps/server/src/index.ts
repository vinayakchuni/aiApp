import { config } from 'dotenv';
config({ path: '../../.env' });

import { app } from './app';
import { startPeriodicCleanup } from './services/cleanup';

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  startPeriodicCleanup();
});
