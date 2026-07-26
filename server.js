const express = require('express');
const db = require('./db');
const { calculateWithdrawalEndDate } = require('./withdrawalCalculator'); 

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static('public'));

// app.get('/',(req,res) => {
//     res.send('Calving Log server is running')
// });

app.get('/api/events', (req, res) => {
  const events = db.prepare(`
    SELECT
      health_events.*,
      drugs.drug_name,
      drugs.milk_withdrawal_days,
      drugs.calculation_basis
    FROM health_events
    LEFT JOIN drugs ON health_events.drug_id = drugs.id
    ORDER BY event_date DESC
  `).all();

  const eventsWithWithdrawal = events.map(event => ({
    ...event,
    withdrawal_end_date: calculateWithdrawalEndDate(event)
  }));

  res.json(eventsWithWithdrawal);
});
app.post('/api/events', (req, res) => {
  const { cow_number, event_type, event_date, notes, drug_id, calving_date } = req.body;

  if (!cow_number || !event_type || !event_date) {
    return res.status(400).json({ error: 'cow_number, event_type and event_date are required' });
  }

  if (drug_id) {
    const drug = db.prepare('SELECT * FROM drugs WHERE id = ?').get(drug_id);
    if (!drug) {
      return res.status(400).json({ error: 'drug_id does not match any known drug' });
    }
  }

  const stmt = db.prepare(`
    INSERT INTO health_events (cow_number, event_type, event_date, notes, drug_id, calving_date)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(cow_number, event_type, event_date, notes || null, drug_id || null, calving_date || null);

  const newEvent = db.prepare('SELECT * FROM health_events WHERE id = ?').get(result.lastInsertRowid);

  res.status(201).json(newEvent);
});

app.delete('/api/events/:id', (req, res) => {
  const { id } = req.params;

  const stmt = db.prepare('DELETE FROM health_events WHERE id = ?');
  const result = stmt.run(id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Event not found' });
  }

  res.status(204).send();
});
 
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

app.listen(PORT,()=>{
    console.log(`Server is listening on the http://localhost:${PORT}`)
})