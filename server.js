const express = require('express');
const app = express();
const PORT = 3000;

app.get('/',(req,res) => {
    res.send('Calving Log server is running')
});

app.listen(PORT,()=>{
    console.log(`Server is listening on the http://localhost:${PORT}`)
})