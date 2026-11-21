import { policyLaps } from './policyLap';

// The trained policies at the two circuits whose laps run in `npm test` (the other 22: test/calendar/, npm run
// test:laps).
policyLaps('melbourne');
policyLaps('silverstone');
