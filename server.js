const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const bwipjs = require('bwip-js');
const PDFDocument = require('pdfkit');
const crypto = require('crypto');
const path = require('path');

const app = express();
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'db', port: Number(process.env.DB_PORT || 3306),
  database: process.env.DB_NAME || 'fishpos', user: process.env.DB_USER || 'fishpos',
  password: process.env.DB_PASSWORD, waitForConnections: true, connectionLimit: 10,
  decimalNumbers: true, timezone: 'Z'
});
const rawPoolQuery = pool.query.bind(pool);
function adapt(sql, params=[]) {
  const ordered=[];
  const statement=sql.replace(/\$(\d+)/g, (_, n) => { ordered.push(params[Number(n)-1]); return '?'; });
  return { statement, values: ordered.length ? ordered : params };
}
async function queryOn(conn, sql, params=[]) {
  const returning = sql.match(/\s+RETURNING\s+(.+)$/i);
  const clean = returning ? sql.slice(0, returning.index) : sql;
  const {statement,values}=adapt(clean,params);
  const [result]=await (conn===pool ? rawPoolQuery(statement,values) : conn.query(statement,values));
  if (returning) {
    const table=(clean.match(/INSERT\s+INTO\s+([a-z_]+)/i)||clean.match(/UPDATE\s+([a-z_]+)/i)||[])[1];
    const where=clean.match(/WHERE\s+id\s*=\s*\$(\d+)/i);
    const id=where ? params[Number(where[1])-1] : result.insertId;
    const cols=returning[1].trim();
    const [rows]=await (conn===pool ? rawPoolQuery(`SELECT ${cols} FROM ${table} WHERE id = ?`,[id]) : conn.query(`SELECT ${cols} FROM ${table} WHERE id = ?`,[id]));
    return {rows,rowCount:rows.length};
  }
  if (Array.isArray(result)) return {rows:result,rowCount:result.length};
  return {rows:[],rowCount:result.affectedRows,insertId:result.insertId};
}
pool.query=(sql,params=[])=>queryOn(pool,sql,params);
pool.connect=async()=>{
 const conn=await pool.getConnection();
 return {query:(sql,params=[])=>queryOn(conn,sql,params),release:()=>conn.release()};
};
const JWT_SECRET = process.env.JWT_SECRET || 'development-only-change-me';
app.use(express.json({ limit: '2mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (_, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (_, f, cb) => cb(null, ['image/jpeg','image/png','image/webp','image/gif'].includes(f.mimetype)) });

function barcodeCheckDigit(body) {
  let sum=0,weight=3;
  for(let i=body.length-1;i>=0;i--){sum+=Number(body[i])*weight;weight=weight===3?1:3;}
  return String((10-(sum%10))%10);
}
function validBarcode(value,type) {
  const digits=String(value||'');
  const length=type==='EAN-13'?13:type==='UPC-A'?12:0;
  return !!length && new RegExp(`^\\d{${length}}$`).test(digits) && barcodeCheckDigit(digits.slice(0,-1))===digits.slice(-1);
}
async function generateBarcode(type) {
  const bodyLength=type==='EAN-13'?12:11;
  for(let attempt=0;attempt<20;attempt++){
    let body='';for(let i=0;i<bodyLength;i++)body+=crypto.randomInt(0,10);
    const barcode=body+barcodeCheckDigit(body);
    const existing=await pool.query('SELECT id FROM fish WHERE barcode=$1',[barcode]);
    if(!existing.rowCount)return barcode;
  }
  throw new Error('Could not create a unique barcode. Please try again.');
}

async function init() {
  const schema = [
    `CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(100) UNIQUE NOT NULL, password_hash VARCHAR(255) NOT NULL, role VARCHAR(20) NOT NULL, active TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS categories (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) UNIQUE NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS fish (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(160) NOT NULL, category_id INT NULL, price_per_kg DECIMAL(12,2) NOT NULL, stock_kg DECIMAL(12,3) NOT NULL DEFAULT 0, barcode VARCHAR(80) UNIQUE NOT NULL, image_path VARCHAR(500), active TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS sales (id INT AUTO_INCREMENT PRIMARY KEY, cashier_id INT, cashier_name VARCHAR(100), total DECIMAL(12,2) NOT NULL, payment_method VARCHAR(20) NOT NULL DEFAULT 'cash', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (cashier_id) REFERENCES users(id)) ENGINE=InnoDB`,
    `CREATE TABLE IF NOT EXISTS sale_items (id INT AUTO_INCREMENT PRIMARY KEY, sale_id INT NOT NULL, fish_id INT, fish_name VARCHAR(160) NOT NULL, weight_kg DECIMAL(10,3) NOT NULL, price_per_kg DECIMAL(12,2) NOT NULL, line_total DECIMAL(12,2) NOT NULL, FOREIGN KEY (sale_id) REFERENCES sales(id) ON DELETE CASCADE, FOREIGN KEY (fish_id) REFERENCES fish(id)) ENGINE=InnoDB`
  ];
  for (const statement of schema) await pool.query(statement);
  await pool.query('ALTER TABLE fish ADD COLUMN IF NOT EXISTS category_id INT NULL');
  await pool.query('ALTER TABLE fish ADD COLUMN IF NOT EXISTS stock_kg DECIMAL(12,3) NOT NULL DEFAULT 0');
  await pool.query(`ALTER TABLE fish ADD COLUMN IF NOT EXISTS barcode_type VARCHAR(10) NOT NULL DEFAULT 'EAN-13'`);
  for (const name of ['Fresh Fish','Shellfish','Dried Fish','Other']) await pool.query('INSERT IGNORE INTO categories(name) VALUES($1)',[name]);
  const existingFish=await pool.query('SELECT id,barcode,barcode_type FROM fish');
  for(const fish of existingFish.rows){if(!validBarcode(fish.barcode,fish.barcode_type)){const barcode=await generateBarcode('EAN-13');await pool.query(`UPDATE fish SET barcode=$1,barcode_type='EAN-13' WHERE id=$2`,[barcode,fish.id]);}}
  await pool.query('ALTER TABLE sales ADD COLUMN IF NOT EXISTS cashier_name VARCHAR(100) NULL');
  await pool.query('UPDATE sales s JOIN users u ON u.id=s.cashier_id SET s.cashier_name=u.username WHERE s.cashier_name IS NULL');
  const admin = await pool.query('SELECT id FROM users WHERE username=$1', [process.env.ADMIN_USERNAME || 'admin']);
  if (!admin.rowCount) {
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD || 'ChangeMe123!', 12);
    await pool.query('INSERT INTO users(username,password_hash,role) VALUES($1,$2,$3)', [process.env.ADMIN_USERNAME || 'admin', hash, 'admin']);
    console.log(`Created initial admin account: ${process.env.ADMIN_USERNAME || 'admin'}`);
  }
}
function auth(req, res, next) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Please sign in to continue.' }); }
}
const adminOnly = (req, res, next) => req.user?.role === 'admin' ? next() : res.status(403).json({ error: 'Admin access required.' });
const adminOrManager = (req,res,next) => ['admin','shop_manager'].includes(req.user?.role) ? next() : res.status(403).json({error:'Admin or shop manager access required.'});
const inventoryReader = (req,res,next) => ['admin','shop_manager','cashier'].includes(req.user?.role) ? next() : res.status(403).json({error:'Management access required.'});
const adminOrCashier = (req,res,next) => ['admin','shop_manager','cashier'].includes(req.user?.role) ? next() : res.status(403).json({error:'Management access required.'});
const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.post('/api/login', asyncRoute(async (req, res) => {
  const { username, password } = req.body || {};
  const { rows } = await pool.query('SELECT id,username,password_hash,role,active FROM users WHERE username=$1', [String(username || '')]);
  const u = rows[0];
  if (!u || !u.active || !(await bcrypt.compare(String(password || ''), u.password_hash))) return res.status(401).json({ error: 'Username or password is incorrect.' });
  const user = { id:u.id, username:u.username, role:u.role };
  res.json({ token: jwt.sign(user, JWT_SECRET, { expiresIn:'12h' }), user });
}));
app.get('/api/me', auth, (req,res) => res.json({ user:req.user }));
app.post('/api/me/password',auth,adminOnly,asyncRoute(async(req,res)=>{
 const current=String(req.body.current_password||''),next=String(req.body.new_password||'');
 if(next.length<8)return res.status(400).json({error:'New password must be at least 8 characters.'});
 if(current===next)return res.status(400).json({error:'Choose a new password different from the current one.'});
 const {rows}=await pool.query('SELECT password_hash FROM users WHERE id=$1 AND active=true',[req.user.id]);
 if(!rows[0]||!(await bcrypt.compare(current,rows[0].password_hash)))return res.status(400).json({error:'Current password is incorrect.'});
 const hash=await bcrypt.hash(next,12);await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2',[hash,req.user.id]);res.json({ok:true});
}));
app.get('/api/categories', auth, asyncRoute(async (req,res) => {
  const {rows}=await pool.query('SELECT id,name FROM categories ORDER BY name');res.json(rows);
}));
app.post('/api/categories',auth,adminOnly,asyncRoute(async(req,res)=>{
 const name=String(req.body.name||'').trim();if(!name||name.length>100)return res.status(400).json({error:'Enter a category name up to 100 characters.'});
 try{const {rows}=await pool.query('INSERT INTO categories(name) VALUES($1) RETURNING id,name',[name]);res.status(201).json(rows[0]);}
 catch(e){if(e.code==='ER_DUP_ENTRY')return res.status(409).json({error:'That category already exists.'});throw e;}
}));
app.put('/api/categories/:id',auth,adminOnly,asyncRoute(async(req,res)=>{
 const name=String(req.body.name||'').trim();if(!name||name.length>100)return res.status(400).json({error:'Enter a category name up to 100 characters.'});
 try{const {rows}=await pool.query('UPDATE categories SET name=$1 WHERE id=$2 RETURNING id,name',[name,req.params.id]);if(!rows[0])return res.status(404).json({error:'Category not found.'});res.json(rows[0]);}
 catch(e){if(e.code==='ER_DUP_ENTRY')return res.status(409).json({error:'That category already exists.'});throw e;}
}));
app.delete('/api/categories/:id',auth,adminOnly,asyncRoute(async(req,res)=>{
 const client=await pool.connect();try{await client.query('BEGIN');const found=await client.query('SELECT id FROM categories WHERE id=$1',[req.params.id]);if(!found.rows[0]){await client.query('ROLLBACK');return res.status(404).json({error:'Category not found.'});}await client.query('UPDATE fish SET category_id=NULL WHERE category_id=$1',[req.params.id]);await client.query('DELETE FROM categories WHERE id=$1',[req.params.id]);await client.query('COMMIT');res.json({ok:true});}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}));
app.get('/api/fish', auth, asyncRoute(async (req,res) => {
  const { rows } = await pool.query('SELECT f.id,f.name,f.category_id,c.name AS category_name,f.price_per_kg,f.stock_kg,f.barcode,f.barcode_type,f.image_path,f.active,f.created_at FROM fish f LEFT JOIN categories c ON c.id=f.category_id WHERE f.active=true ORDER BY f.name'); res.json(rows);
}));
app.get('/api/inventory',auth,inventoryReader,asyncRoute(async(req,res)=>{const {rows}=await pool.query('SELECT f.id,f.name,f.stock_kg,f.price_per_kg,c.name AS category_name FROM fish f LEFT JOIN categories c ON c.id=f.category_id WHERE f.active=true ORDER BY f.name');res.json(rows);}));
app.post('/api/inventory/:id/add',auth,adminOrManager,asyncRoute(async(req,res)=>{const kg=Number(req.body.kg);if(!Number.isFinite(kg)||kg<=0||kg>1000000)return res.status(400).json({error:'Enter an amount greater than 0 kg.'});const {rows}=await pool.query('UPDATE fish SET stock_kg=stock_kg+$1 WHERE id=$2 AND active=true RETURNING id,name,stock_kg',[kg,req.params.id]);if(!rows[0])return res.status(404).json({error:'Active fish product not found.'});res.json(rows[0]);}));
app.get('/api/fish/barcode/:code', auth, asyncRoute(async (req,res) => {
  const { rows } = await pool.query('SELECT id,name,price_per_kg,barcode,image_path FROM fish WHERE barcode=$1 AND active=true',[req.params.code]);
  if (!rows[0]) return res.status(404).json({error:'No fish found for that barcode.'}); res.json(rows[0]);
}));
app.post('/api/fish', auth, adminOrCashier, upload.single('image'), asyncRoute(async (req,res) => {
  const name=String(req.body.name||'').trim(), price=Number(req.body.price_per_kg), stock=Number(req.body.stock_kg||0), categoryId=req.body.category_id?Number(req.body.category_id):null, barcodeType=String(req.body.barcode_type||'EAN-13');
  if (!name || !Number.isFinite(price) || price < 0 || !Number.isFinite(stock) || stock < 0 || stock > 1000000) return res.status(400).json({error:'Enter a fish name, valid price, and inventory quantity from 0 to 1,000,000 kg.'});
  const existing=await pool.query('SELECT id,name,stock_kg FROM fish WHERE LOWER(TRIM(name))=LOWER(TRIM($1)) AND active=true ORDER BY id LIMIT 1',[name]);
  if(existing.rows[0]){
    if(stock<=0)return res.status(400).json({error:`${existing.rows[0].name} already exists. Enter a stock quantity greater than 0 kg to add inventory.`});
    const {rows}=await pool.query('UPDATE fish SET stock_kg=stock_kg+$1 WHERE id=$2 RETURNING id,name,stock_kg',[stock,existing.rows[0].id]);
    return res.status(200).json({...rows[0],existing:true});
  }
  let barcode=String(req.body.barcode||'').trim();
  if(!['EAN-13','UPC-A'].includes(barcodeType))return res.status(400).json({error:'Choose EAN-13 or UPC-A.'});
  if(!barcode)barcode=await generateBarcode(barcodeType);
  if(!validBarcode(barcode,barcodeType))return res.status(400).json({error:`Enter a valid ${barcodeType} number with a correct check digit, or leave it blank to generate one.`});
  const image=req.file ? `/uploads/${req.file.filename}` : null;
  try { const {rows}=await pool.query('INSERT INTO fish(name,category_id,price_per_kg,stock_kg,barcode,barcode_type,image_path) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *',[name,categoryId,price,stock,barcode,barcodeType,image]); res.status(201).json(rows[0]); }
  catch(e) { if(e.code==='ER_DUP_ENTRY') return res.status(409).json({error:'That barcode is already assigned.'}); throw e; }
}));
app.put('/api/fish/:id', auth, adminOnly, upload.single('image'), asyncRoute(async (req,res) => {
  const name=String(req.body.name||'').trim(), price=Number(req.body.price_per_kg), categoryId=req.body.category_id?Number(req.body.category_id):null, barcodeType=String(req.body.barcode_type||'EAN-13');
  let barcode=String(req.body.barcode||'').trim();
  if(!name||!Number.isFinite(price)||price<0) return res.status(400).json({error:'Enter a fish name and valid price.'});
  if(!['EAN-13','UPC-A'].includes(barcodeType))return res.status(400).json({error:'Choose EAN-13 or UPC-A.'});
  if(!barcode)barcode=await generateBarcode(barcodeType);
  if(!validBarcode(barcode,barcodeType))return res.status(400).json({error:`Enter a valid ${barcodeType} number with a correct check digit, or leave it blank to generate one.`});
  const old=await pool.query('SELECT image_path FROM fish WHERE id=$1',[req.params.id]); if(!old.rowCount) return res.status(404).json({error:'Fish not found.'});
  const image=req.file ? `/uploads/${req.file.filename}` : old.rows[0].image_path;
  try { const {rows}=await pool.query('UPDATE fish SET name=$1,category_id=$2,price_per_kg=$3,barcode=$4,barcode_type=$5,image_path=$6 WHERE id=$7 RETURNING *',[name,categoryId,price,barcode,barcodeType,image,req.params.id]); res.json(rows[0]); }
  catch(e) { if(e.code==='ER_DUP_ENTRY') return res.status(409).json({error:'That barcode is already assigned.'}); throw e; }
}));
app.delete('/api/fish/:id', auth, adminOnly, asyncRoute(async(req,res)=>{await pool.query('UPDATE fish SET active=false WHERE id=$1',[req.params.id]);res.json({ok:true});}));
app.get('/api/fish/:id/barcode.svg', auth, adminOrCashier, asyncRoute(async(req,res)=>{
  const {rows}=await pool.query('SELECT name,barcode,barcode_type FROM fish WHERE id=$1 AND active=true',[req.params.id]); if(!rows[0]) return res.status(404).end();
  const bcid=rows[0].barcode_type==='UPC-A'?'upca':'ean13';
  const svg=bwipjs.toSVG({bcid,text:rows[0].barcode,scale:3,height:16,includetext:true,textxalign:'center',backgroundcolor:'FFFFFF'}); res.type('image/svg+xml').send(svg);
}));
app.post('/api/fish/barcodes/print',auth,adminOrCashier,asyncRoute(async(req,res)=>{
 const ids=Array.isArray(req.body.ids)?[...new Set(req.body.ids.map(Number).filter(Number.isInteger))]:[];
 if(!ids.length||ids.length>500)return res.status(400).json({error:'Select between 1 and 500 fish products to print.'});
 const placeholders=ids.map((_,i)=>`$${i+1}`).join(',');
 const {rows}=await pool.query(`SELECT f.id,f.name,f.price_per_kg,f.barcode,f.barcode_type,f.category_id,c.name AS category_name FROM fish f LEFT JOIN categories c ON c.id=f.category_id WHERE f.active=true AND f.id IN (${placeholders}) ORDER BY f.name`,ids);
 if(!rows.length)return res.status(404).json({error:'No active fish products were found for these labels.'});
 const htmlEscape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const labels=(await Promise.all(rows.map(async f=>{
  const bcid=f.barcode_type==='UPC-A'?'upca':'ean13';
  const svg=bwipjs.toSVG({bcid,text:f.barcode,scale:2.5,height:13,includetext:true,textxalign:'center',backgroundcolor:'FFFFFF'});
  const image=Buffer.from(svg).toString('base64');
  return `<article class="label"><strong>${htmlEscape(f.name)}</strong><img src="data:image/svg+xml;base64,${image}" alt="${htmlEscape(f.barcode_type)} barcode ${htmlEscape(f.barcode)}"><div>${htmlEscape(f.barcode_type)} · ${htmlEscape(f.barcode)}</div><small>${htmlEscape(f.category_name||'Uncategorized')} · ₱${Number(f.price_per_kg).toFixed(2)} / kg</small></article>`;
 }))).join('');
 res.json({html:`<!doctype html><html><head><meta charset="utf-8"><title>Fish barcode labels</title><style>@page{margin:8mm}*{box-sizing:border-box}body{font:12px Arial,sans-serif;color:#222;margin:0}.sheet{display:grid;grid-template-columns:repeat(2,70mm);gap:4mm;justify-content:center}.label{width:70mm;min-height:36mm;padding:3mm;border:1px dashed #bbb;text-align:center;display:flex;flex-direction:column;align-items:center;justify-content:center;break-inside:avoid;page-break-inside:avoid}.label strong{font-size:13px;margin-bottom:1mm}.label img{display:block;width:64mm;height:18mm;object-fit:contain}.label div{font-size:10px;letter-spacing:.2px}.label small{font-size:9px;margin-top:1mm}@media screen{body{padding:12px}.label{margin:0 auto}}</style></head><body><main class="sheet">${labels}</main><script>window.onload=()=>setTimeout(()=>{window.focus();window.print()},250)</script></body></html>`});
}));
app.get('/api/users',auth,adminOnly,asyncRoute(async(req,res)=>{const {rows}=await pool.query('SELECT id,username,role,active,created_at FROM users ORDER BY id');res.json(rows);}));
app.post('/api/users',auth,adminOnly,asyncRoute(async(req,res)=>{
 const username=String(req.body.username||'').trim(),password=String(req.body.password||''),role=req.body.role;
 if(username.length<3||password.length<8||!['admin','cashier','shop_manager'].includes(role)) return res.status(400).json({error:'Username must have 3+ characters, password 8+, and role must be admin, shop manager, or cashier.'});
 try{const hash=await bcrypt.hash(password,12);const {rows}=await pool.query('INSERT INTO users(username,password_hash,role) VALUES($1,$2,$3) RETURNING id,username,role,active',[username,hash,role]);res.status(201).json(rows[0]);}
 catch(e){if(e.code==='ER_DUP_ENTRY') return res.status(409).json({error:'That username is already in use.'});throw e;}
}));
app.patch('/api/users/:id',auth,adminOnly,asyncRoute(async(req,res)=>{
 if(Number(req.params.id)===req.user.id && req.body.active===false) return res.status(400).json({error:'You cannot deactivate your own account.'});
 const {rows}=await pool.query('UPDATE users SET active=COALESCE($1,active), role=COALESCE($2,role) WHERE id=$3 RETURNING id,username,role,active',[req.body.active===undefined?null:!!req.body.active, ['admin','cashier','shop_manager'].includes(req.body.role)?req.body.role:null,req.params.id]); if(!rows[0]) return res.status(404).json({error:'User not found.'});res.json(rows[0]);
}));
app.delete('/api/users/:id',auth,adminOnly,asyncRoute(async(req,res)=>{
 const client=await pool.connect();
 try{
  await client.query('BEGIN');
  const {rows}=await client.query('SELECT id,username,role FROM users WHERE id=$1',[req.params.id]);
  if(!rows[0]){await client.query('ROLLBACK');return res.status(404).json({error:'User not found.'});}
  if(rows[0].role==='admin'){await client.query('ROLLBACK');return res.status(400).json({error:'Admin accounts cannot be removed here.'});}
  await client.query('UPDATE sales SET cashier_name=COALESCE(cashier_name,$1), cashier_id=NULL WHERE cashier_id=$2',[rows[0].username,req.params.id]);
  await client.query('DELETE FROM users WHERE id=$1',[req.params.id]);
  await client.query('COMMIT');res.json({ok:true});
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}));
app.post('/api/sales',auth,asyncRoute(async(req,res)=>{
 const lines=req.body.items;
 if(!Array.isArray(lines)||!lines.length) return res.status(400).json({error:'Add at least one item to the basket.'});
 const client=await pool.connect();
 try{
  await client.query('BEGIN'); let total=0; const prepared=[];
  for(const line of lines){const weight=Number(line.weight_kg), {rows}=await client.query('SELECT id,name,price_per_kg,stock_kg FROM fish WHERE id=$1 AND active=true FOR UPDATE',[line.fish_id]);
   if(!rows[0]||!Number.isFinite(weight)||weight<=0||weight>1000) throw new Error('Check each fish and its weight (greater than 0 kg).');
   const f=rows[0];if(Number(f.stock_kg)<weight)throw new Error(`${f.name}: only ${Number(f.stock_kg).toFixed(3)} kg remains in inventory.`);await client.query('UPDATE fish SET stock_kg=stock_kg-$1 WHERE id=$2',[weight,f.id]);
   const amount=Math.round(Number(f.price_per_kg)*weight*100)/100; total+=amount; prepared.push({fish:f,weight,amount});
  }
  total=Math.round(total*100)/100; const sale=await client.query('INSERT INTO sales(cashier_id,cashier_name,total,payment_method) VALUES($1,$2,$3,$4) RETURNING id,created_at,total',[req.user.id,req.user.username,total,'cash']);
  for(const p of prepared) await client.query('INSERT INTO sale_items(sale_id,fish_id,fish_name,weight_kg,price_per_kg,line_total) VALUES($1,$2,$3,$4,$5,$6)',[sale.rows[0].id,p.fish.id,p.fish.name,p.weight,p.fish.price_per_kg,p.amount]);
  await client.query('COMMIT');res.status(201).json({...sale.rows[0],items:prepared.map(p=>({name:p.fish.name,weight_kg:p.weight,price_per_kg:p.fish.price_per_kg,line_total:p.amount}))});
 }catch(e){await client.query('ROLLBACK');res.status(400).json({error:e.message});}finally{client.release();}
}));
app.get('/api/sales',auth,adminOnly,asyncRoute(async(req,res)=>{
 const {rows}=await pool.query(`SELECT s.id,s.total,s.created_at,COALESCE(s.cashier_name,u.username,'Removed cashier') AS cashier FROM sales s LEFT JOIN users u ON u.id=s.cashier_id ORDER BY s.created_at DESC LIMIT 100`); for(const sale of rows){const items=await pool.query('SELECT fish_name AS name,weight_kg,line_total FROM sale_items WHERE sale_id=$1',[sale.id]);sale.items=items.rows;} res.json(rows);
}));
app.get('/api/dashboard/options',auth,adminOrManager,asyncRoute(async(req,res)=>{
 const categories=await pool.query('SELECT id,name FROM categories ORDER BY name');
 const cashiers=await pool.query(`SELECT DISTINCT COALESCE(s.cashier_name,u.username,'Removed cashier') AS name FROM sales s LEFT JOIN users u ON u.id=s.cashier_id ORDER BY name`);
 res.json({categories:categories.rows,cashiers:cashiers.rows.map(r=>r.name)});
}));
app.get('/api/dashboard',auth,adminOrManager,asyncRoute(async(req,res)=>{
 const category=req.query.category||'',cashier=String(req.query.cashier||'').trim();
 const start=String(req.query.start||''),end=String(req.query.end||'');
 const validDate=value=>!value||/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value);
 if(!validDate(start)||!validDate(end))return res.status(400).json({error:'Use a valid start and end date and time.'});
 const scope=(includeCategory=true,includeCashier=true)=>{
  const clauses=[],values=[];const add=(template,value)=>{values.push(value);clauses.push(template.replace('?',`$${values.length}`));};
  if(start)add('s.created_at >= ?',start);if(end)add('s.created_at <= ?',end);
  if(includeCashier&&cashier)add(`COALESCE(s.cashier_name,u.username,'Removed cashier') = ?`,cashier);
  if(includeCategory&&category==='uncategorized')clauses.push('f.category_id IS NULL');
  else if(includeCategory&&category)add('f.category_id = ?',Number(category));
  return {where:clauses.length?'WHERE '+clauses.join(' AND '):'',values};
 };
 const all=scope(true,true);
 const aggregate=await pool.query(`SELECT COUNT(DISTINCT s.id) AS sale_count,COALESCE(SUM(i.line_total),0) AS revenue,COALESCE(SUM(i.weight_kg),0) AS weight_kg,COALESCE(SUM(i.line_total),0)/NULLIF(COUNT(DISTINCT s.id),0) AS average_sale FROM sales s JOIN sale_items i ON i.sale_id=s.id LEFT JOIN fish f ON f.id=i.fish_id LEFT JOIN users u ON u.id=s.cashier_id ${all.where}` ,all.values);
 const useHourly=start&&end&&(new Date(end.replace(' ','T')+'Z')-new Date(start.replace(' ','T')+'Z'))<=48*3600*1000;
 const bucket=useHourly?`DATE_FORMAT(s.created_at,'%Y-%m-%d %H:00')`:`DATE_FORMAT(s.created_at,'%Y-%m-%d')`;
 const trend=await pool.query(`SELECT ${bucket} AS label,COALESCE(SUM(i.line_total),0) AS revenue,COUNT(DISTINCT s.id) AS sale_count FROM sales s JOIN sale_items i ON i.sale_id=s.id LEFT JOIN fish f ON f.id=i.fish_id LEFT JOIN users u ON u.id=s.cashier_id ${all.where} GROUP BY label ORDER BY label`,all.values);
 const trendByCategory=await pool.query(`SELECT DATE_FORMAT(s.created_at,'%Y-%m-%d') AS label,COALESCE(c.name,'Uncategorized') AS category,COALESCE(SUM(i.line_total),0) AS revenue FROM sales s JOIN sale_items i ON i.sale_id=s.id LEFT JOIN fish f ON f.id=i.fish_id LEFT JOIN categories c ON c.id=f.category_id LEFT JOIN users u ON u.id=s.cashier_id ${all.where} GROUP BY label,category ORDER BY label,category`,all.values);
 const categoryRows=await pool.query(`SELECT COALESCE(c.name,'Uncategorized') AS name,COALESCE(SUM(i.line_total),0) AS revenue FROM sales s JOIN sale_items i ON i.sale_id=s.id LEFT JOIN fish f ON f.id=i.fish_id LEFT JOIN categories c ON c.id=f.category_id LEFT JOIN users u ON u.id=s.cashier_id ${all.where} GROUP BY c.id,c.name ORDER BY revenue DESC`,all.values);
 const cashierRows=await pool.query(`SELECT COALESCE(s.cashier_name,u.username,'Removed cashier') AS name,COALESCE(SUM(i.line_total),0) AS revenue FROM sales s JOIN sale_items i ON i.sale_id=s.id LEFT JOIN fish f ON f.id=i.fish_id LEFT JOIN users u ON u.id=s.cashier_id ${all.where} GROUP BY name ORDER BY revenue DESC`,all.values);
 const fishRows=await pool.query(`SELECT i.fish_name AS name,COALESCE(SUM(i.line_total),0) AS revenue FROM sales s JOIN sale_items i ON i.sale_id=s.id LEFT JOIN fish f ON f.id=i.fish_id LEFT JOIN users u ON u.id=s.cashier_id ${all.where} GROUP BY i.fish_name ORDER BY revenue DESC`,all.values);
 const recent=await pool.query(`SELECT s.id,MAX(s.created_at) AS created_at,COALESCE(s.cashier_name,u.username,'Removed cashier') AS cashier,COALESCE(SUM(i.line_total),0) AS filtered_total,COUNT(i.id) AS item_count FROM sales s JOIN sale_items i ON i.sale_id=s.id LEFT JOIN fish f ON f.id=i.fish_id LEFT JOIN users u ON u.id=s.cashier_id ${all.where} GROUP BY s.id,cashier ORDER BY created_at DESC LIMIT 50`,all.values);
 res.json({metrics:aggregate.rows[0],trend:trend.rows,trendByCategory:trendByCategory.rows,categories:categoryRows.rows,fishTypes:fishRows.rows,cashiers:cashierRows.rows,recent:recent.rows,hourly:!!useHourly});
}));
async function getSalesExportRows(query,user){
 const start=String(query.start||''),end=String(query.end||''),cashier=user.role==='cashier'?user.username:String(query.cashier||'').trim(),category=String(query.category||'');
 const validDate=value=>!value||/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value);
 if(!validDate(start)||!validDate(end))throw Object.assign(new Error('Use valid date and time filters.'),{status:400});
 if(category&&category!=='uncategorized'&&!/^\d+$/.test(category))throw Object.assign(new Error('Invalid category filter.'),{status:400});
 const clauses=[],values=[];const add=(sql,value)=>{values.push(value);clauses.push(sql.replace('?',`$${values.length}`));};
 if(start)add('s.created_at >= ?',start);if(end)add('s.created_at <= ?',end);if(cashier)add(`COALESCE(s.cashier_name,u.username,'Removed cashier') = ?`,cashier);
 if(category==='uncategorized')clauses.push('f.category_id IS NULL');else if(category)add('f.category_id = ?',Number(category));
 const {rows}=await pool.query(`SELECT s.id,s.created_at,COALESCE(s.cashier_name,u.username,'Removed cashier') AS cashier,s.payment_method,i.fish_name,i.weight_kg,i.price_per_kg,i.line_total,COALESCE(c.name,'Uncategorized') AS category_name FROM sales s JOIN sale_items i ON i.sale_id=s.id LEFT JOIN fish f ON f.id=i.fish_id LEFT JOIN categories c ON c.id=f.category_id LEFT JOIN users u ON u.id=s.cashier_id ${clauses.length?'WHERE '+clauses.join(' AND '):''} ORDER BY s.created_at DESC,s.id DESC,i.id`,values);
 const sales=[],byId=new Map();for(const row of rows){let sale=byId.get(row.id);if(!sale){sale={id:row.id,created_at:row.created_at,cashier:row.cashier,payment_method:row.payment_method,items:[],total:0};byId.set(row.id,sale);sales.push(sale)}const item={name:row.fish_name,category:row.category_name,weight:Number(row.weight_kg),price:Number(row.price_per_kg),lineTotal:Number(row.line_total)};sale.items.push(item);sale.total+=item.lineTotal;}for(const sale of sales)sale.total=Math.round(sale.total*100)/100;return sales;
}
app.get('/api/sales/export/options',auth,adminOrCashier,asyncRoute(async(req,res)=>{
 const categories=await pool.query('SELECT id,name FROM categories ORDER BY name');
 const cashiers=req.user.role==='cashier'?{rows:[{name:req.user.username}]}:await pool.query(`SELECT DISTINCT COALESCE(s.cashier_name,u.username,'Removed cashier') AS name FROM sales s LEFT JOIN users u ON u.id=s.cashier_id ORDER BY name`);
 res.json({categories:categories.rows,cashiers:cashiers.rows.map(x=>x.name)});
}));
app.get('/api/sales/export',auth,adminOrCashier,asyncRoute(async(req,res)=>{
 const sales=await getSalesExportRows(req.query,req.user),format=String(req.query.format||'csv').toLowerCase();
 if(!['csv','pdf'].includes(format))return res.status(400).json({error:'Choose CSV or PDF export.'});
 const timestamp=new Date().toISOString().slice(0,10);
 if(format==='csv'){
  const csvCell=value=>{let text=String(value??'');if(/^[=+@-]/.test(text))text="'"+text;return `"${text.replace(/"/g,'""')}"`};
  const lines=[['Date and time (GMT+8)','Sale ID','Cashier','Fish item','Weight (kg)','Price per kg (PHP)','Line total (PHP)','Sale total (PHP)','Payment method'].map(csvCell).join(',')];
  for(const sale of sales)for(const item of sale.items)lines.push([new Date(sale.created_at).toLocaleString('en-PH',{timeZone:'Asia/Manila'}),sale.id,sale.cashier,item.name,item.weight.toFixed(3),item.price.toFixed(2),item.lineTotal.toFixed(2),sale.total.toFixed(2),sale.payment_method].map(csvCell).join(','));
  res.setHeader('Content-Disposition',`attachment; filename="myco-sales-${timestamp}.csv"`);res.type('text/csv; charset=utf-8').send('\uFEFF'+lines.join('\r\n'));return;
 }
 res.setHeader('Content-Disposition',`attachment; filename="myco-sales-${timestamp}.pdf"`);res.type('application/pdf');
 const doc=new PDFDocument({size:'A4',layout:'landscape',margin:30});doc.pipe(res);
 const cols=[['Date / time',102],['Sale',48],['Cashier',96],['Fish item',218],['Weight',62],['PHP / kg',78],['Line total',82],['Sale total',82]];
 const columnX=[];let columnCursor=30;for(const [,w] of cols){columnX.push(columnCursor);columnCursor+=w;}
 const drawHeader=()=>{const y=doc.y;doc.font('Helvetica-Bold').fontSize(8).fillColor('#416c36');cols.forEach(([label,w],i)=>doc.text(label,columnX[i],y,{width:w-6,height:18,align:i>=4?'right':'left',lineBreak:false}));doc.y=y+19;doc.moveTo(30,doc.y).lineTo(columnCursor,doc.y).strokeColor('#cad8c1').stroke();doc.y+=7;};
 doc.font('Helvetica-Bold').fontSize(17).fillColor('#345b2c').text('My.Co Enterprises - Sales Export');doc.moveDown(.35);doc.font('Helvetica').fontSize(8).fillColor('#64705f').text(`Generated ${new Date().toLocaleString('en-PH',{timeZone:'Asia/Manila'})} (GMT+8) | ${sales.length} sales`);doc.moveDown(1);drawHeader();
 if(!sales.length){doc.fontSize(11).fillColor('#555').text('No sales match the selected filters.');}
 else for(const sale of sales){for(const item of sale.items){const date=new Date(sale.created_at).toLocaleString('en-PH',{timeZone:'Asia/Manila',dateStyle:'short',timeStyle:'short'});const values=[date,`#${sale.id}`,sale.cashier,item.name,`${item.weight.toFixed(3)} kg`,item.price.toFixed(2),item.lineTotal.toFixed(2),sale.total.toFixed(2)];doc.font('Helvetica').fontSize(7);const height=Math.max(20,...values.map((v,i)=>doc.heightOfString(String(v),{width:cols[i][1]-8})))+5;if(doc.y+height>doc.page.height-30){doc.addPage();drawHeader()}const y=doc.y;values.forEach((v,i)=>doc.text(String(v),columnX[i],y,{width:cols[i][1]-8,height:height-3,align:i>=4?'right':'left',ellipsis:true}));doc.y=y+height;doc.moveTo(30,doc.y).lineTo(columnCursor,doc.y).strokeColor('#edf0e9').stroke();}}
 const netSales=Math.round(sales.reduce((sum,sale)=>sum+sale.total,0)*100)/100,categoryTotals=new Map(),fishTotals=new Map();for(const sale of sales)for(const item of sale.items){categoryTotals.set(item.category,(categoryTotals.get(item.category)||0)+item.lineTotal);fishTotals.set(item.name,(fishTotals.get(item.name)||0)+item.lineTotal)}
 doc.addPage({size:'A4',layout:'portrait',margin:42});doc.font('Helvetica-Bold').fontSize(20).fillColor('#345b2c').text('Sales summary');doc.moveDown(.4);doc.font('Helvetica').fontSize(10).fillColor('#64705f').text(`${sales.length} transactions`);doc.moveDown(.6);doc.roundedRect(42,doc.y,510,58,12).fill('#eff6e9');doc.font('Helvetica').fontSize(10).fillColor('#58734d').text('TOTAL NET SALES',60,doc.y+14);doc.font('Helvetica-Bold').fontSize(21).fillColor('#345b2c').text(`₱${netSales.toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}`,350,doc.y-3,{width:180,align:'right'});doc.y+=75;
 const drawBarGraph=(title,entries,color)=>{doc.font('Helvetica-Bold').fontSize(13).fillColor('#344b32').text(title);doc.moveDown(.35);const rows=[...entries.entries()].sort((a,b)=>b[1]-a[1]).slice(0,12),max=Math.max(1,...rows.map(x=>x[1]));if(!rows.length){doc.font('Helvetica').fontSize(9).fillColor('#71816c').text('No sales for this selection.');doc.moveDown(.8);return}for(const [label,value] of rows){if(doc.y>doc.page.height-65)doc.addPage({size:'A4',layout:'portrait',margin:42});const y=doc.y;doc.font('Helvetica').fontSize(8).fillColor('#465642').text(label,42,y,{width:150,ellipsis:true,lineBreak:false});doc.roundedRect(200,y+1,250,9,4).fill('#edf1e7');doc.roundedRect(200,y+1,Math.max(3,250*value/max),9,4).fill(color);doc.font('Helvetica-Bold').fontSize(8).fillColor('#465642').text(`₱${value.toLocaleString('en-PH',{minimumFractionDigits:2,maximumFractionDigits:2})}`,458,y,{width:95,align:'right',lineBreak:false});doc.y=y+20}doc.moveDown(.8)};
 drawBarGraph('Sales by category',categoryTotals,'#eab94c');drawBarGraph('Sales by fish type',fishTotals,'#4f963f');doc.end();
}));
app.get('/api/health',asyncRoute(async(_,res)=>{await pool.query('SELECT 1');res.json({ok:true});}));
app.use((err,req,res,next)=>{console.error(err); if(err instanceof multer.MulterError) return res.status(400).json({error:'Image upload failed. Images must be under 5 MB.'});res.status(err.status||500).json({error:err.status?err.message:'Something went wrong. Please try again.'});});
const port=process.env.PORT||3000;
init().then(()=>app.listen(port,()=>console.log(`Fish POS listening on ${port}`))).catch(e=>{console.error('Database initialization failed:',e);process.exit(1);});
