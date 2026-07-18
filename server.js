const express = require('express');
const db = require('./db');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static('public'));

// app.get('/',(req,res) => {
//     res.send('Calving Log server is running')
// });

app.get('/api/events',(req,res) => {
    const events = db.prepare('SELECT * FROM health_events ORDER BY event_date DESC').all();
    res.json(events);
});

app.post('/api/events',(req,res) => {
    const { cow_number, event_type, event_date, notes} = req.body;

    if(!cow_number || !event_type || !event_date){
    return res.status(400).json({ error: 'cow_number, event_type and event_date are required' });
  }

  const stmt = db.prepare(`
    INSERT INTO health_events (cow_number, event_type, event_date, notes)
    VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(cow_number, event_type, event_date, notes || null);

  const newEvent = db.prepare('SELECT * FROM health_events WHERE id = ?').get(result.lastInsertRowid);

  res.status(201).json(newEvent);
});
 
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

app.listen(PORT,()=>{
    console.log(`Server is listening on the http://localhost:${PORT}`)
})