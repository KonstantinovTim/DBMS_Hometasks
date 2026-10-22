// Готовая инфраструктура: контрольные данные, проверки и сохранение результатов.
// Учебные функции находятся только в solution.js. Команды: docker compose run --rm lab help.
(async function main(){
const fs=require('fs');
const scenario=process.env.HW_CASE||'help';
const log=(label,value)=>{print('\n'+label);if(value!==undefined) print(EJSON.stringify(value,null,2,{relaxed:true}));};
async function initReplicaSet(){
  try { await rs.status(); }
  catch(e){
    if(e.code!==94) throw e;
    await rs.initiate({_id:'hw2rs',members:[
      {_id:0,host:'m1:27017'}, {_id:1,host:'m2:27017'}, {_id:2,host:'m3:27017'}
    ]});
  }
  for(let i=0;i<90;i++){
    const s=await rs.status();
    if(s.members.length===3&&s.members.filter(m=>m.stateStr==='PRIMARY').length===1&&
       s.members.filter(m=>m.stateStr==='SECONDARY').length===2){
      printjson(s.members.map(m=>({host:m.name,role:m.stateStr}))); return;
    }
    await sleep(1000);
  }
  throw Error('Replica set не готов: docker compose logs init m1 m2 m3');
}
if(scenario==='init'){await initReplicaSet();return;}
globalThis.HW = {
  name:'hw2', datasetVersion:'2026-10-05', wc:{w:'majority',j:true,wtimeout:10000},
  from:ISODate('2026-01-01T00:00:00Z'), to:ISODate('2026-02-01T00:00:00Z'),
  products:()=>[
    ['A','Футболка','clothes','100.00',0,10],
    ['B','Рубашка','clothes','80.00',5,4],
    ['C','Толстовка','clothes','90.00',3,2],
    ['D','Ремень','accessories','120.00',4,6],
    ['E','Сумка','accessories','200.00',2,1],
    ['F','Шарф','accessories','150.00',1,8]
  ].map(([sku,name,category,price,l,m])=>({_id:sku,name,category,price:NumberDecimal(price),
      variants:[{size:'L',stock:NumberInt(l)},{size:'M',stock:NumberInt(m)}]})),
  item:(sku,size,qty,price)=>({sku,size,qty:NumberInt(qty),price:NumberDecimal(price)}),
  historyExpected:['H24','H25','H22','H23','H20','H21','H18','H19','H16','H17','H14','H15','H12','H13','H10','H11','H08','H09','H06','H07'],
  reportExpected:[
    {sku:'A',name:'Футболка',qty:3,revenue:'320.00'},
    {sku:'B',name:'Рубашка',qty:4,revenue:'320.00'},
    {sku:'C',name:'Толстовка',qty:3,revenue:'270.00'},
    {sku:'D',name:'Ремень',qty:2,revenue:'240.00'},
    {sku:'E',name:'Сумка',qty:1,revenue:'200.00'}
  ]
};
HW.order = (id,date,items,status='paid',userId=2500)=>({
  _id:id,userId:NumberInt(userId),createdAt:ISODate(date),status,items
});
HW.orders = ()=>[
  HW.order('sale-start','2026-01-01T00:00:00Z',[HW.item('A','M',2,'100.00'),HW.item('B','L',4,'80.00')]),
  HW.order('sale-middle','2026-01-15T12:00:00Z',[HW.item('A','L',1,'120.00'),HW.item('C','M',3,'90.00')]),
  HW.order('sale-last','2026-01-31T23:59:59.999Z',[HW.item('D','L',2,'120.00'),HW.item('E','M',1,'200.00'),HW.item('F','L',1,'150.00')]),
  HW.order('excluded-end','2026-02-01T00:00:00Z',[HW.item('A','M',999,'100.00')]),
  HW.order('excluded-before','2025-12-31T23:59:59.999Z',[HW.item('A','M',999,'100.00')]),
  HW.order('excluded-created','2026-01-15T00:00:00Z',[HW.item('A','M',999,'100.00')],'created'),
  HW.order('excluded-cancelled','2026-01-15T00:00:00Z',[HW.item('A','M',999,'100.00')],'cancelled'),
  ...Array.from({length:26},(_,i)=>HW.order('H'+String(i).padStart(2,'0'),
    new Date(Date.UTC(2026,2,1,Math.floor(i/2))).toISOString(),[HW.item('F','M',1,'150.00')])),
  HW.order('other-user','2026-04-01T00:00:00Z',[HW.item('F','M',1,'150.00')],'paid',2501),
  HW.order('other-status','2026-04-01T00:00:00Z',[HW.item('F','M',1,'150.00')],'cancelled')
];
HW.reset = async (orders=true)=>{
  // Только специально выделенная база в отдельном Compose-проекте.
  const c=db.getSiblingDB(HW.name);
  await c.dropDatabase();
  await c.createCollection('products'); await c.createCollection('orders');
  await c.products.insertMany(HW.products(),{writeConcern:HW.wc});
  if(orders) await c.orders.insertMany(HW.orders(),{writeConcern:HW.wc});
  return c;
};
HW.largeOrders = ()=>Array.from({length:10000},(_,i)=>HW.order(
  'G'+String(i).padStart(5,'0'), new Date(Date.UTC(2026,4,1)+Math.floor(i/2)*60000).toISOString(),
  [HW.item('F','M',1,'150.00')],i%4<2?'paid':'created',i%100<30?2500:3000+i%71
));
// Общие коды отказов отделены от текста сообщения.
globalThis.HWError = (code, message = code) => {
  const error = new Error(message);
  error.code = code;
  return error;
};

// Оболочка для подтверждённого commit и управляемого abort.
// Не реализует протокол повторов при неопределённом результате commit.
globalThis.transaction = async (body)=>{
  const session=db.getMongo().startSession({causalConsistency:true});
  try {
    session.startTransaction({readConcern:{level:'snapshot'},writeConcern:HW.wc,readPreference:'primary'});
    let result;
    try { result=await body(session.getDatabase(HW.name)); }
    catch(e) { await session.abortTransaction(); throw e; }
    // Ошибку commit не называем успешным abort: исход может быть неопределённым.
    await session.commitTransaction();
    return result;
  } finally { await session.endSession(); }
};

// Снимки снимаются с primary вне транзакционной сессии.
// Не запускайте параллельно другие сценарии и не переключайте primary.
globalThis.snapshotTransactions = async () => {
  const s = await db.getSiblingDB('admin').runCommand({serverStatus:1, transactions:1});
  if (s.ok !== 1 || !s.transactions) throw new Error('serverStatus.transactions unavailable');
  return {host:s.host, pid:s.pid, uptime:s.uptime, localTime:s.localTime, transactions:s.transactions};
};
globalThis.measureTransactions = async (scenario, operation, save) => {
  const before = await snapshotTransactions();
  let result, error;
  try { result = await operation(); } catch(e) { error = e; }
  const after = await snapshotTransactions();
  const sameProcess = before.host === after.host && Number(before.pid) === Number(after.pid) &&
    Number(after.uptime) >= Number(before.uptime);
  const delta = Object.fromEntries(['totalStarted','totalCommitted','totalAborted'].map(
    key => [key, Number(after.transactions[key]) - Number(before.transactions[key])]
  ));
  const evidence = {scenario, before, after, delta, sameProcess};
  save('transactions-' + scenario, evidence);
  if (!sameProcess) throw new Error('Повторите опыт: primary или процесс изменился между снимками');
  // Отличие от +1 обсудите в README: например, при повторной попытке транзакции.
  // Эти снимки дополняют проверку данных и кода, но сами по себе её не заменяют.
  return {result, error, evidence};
};

if(scenario==='help'){
  print(`MongoDB — домашняя работа
  docker compose up -d                      Поднять три узла и инициализировать replica set
  docker compose run --rm lab reset          Восстановить 6 товаров и 35 заказов; сбросить старые результаты
  docker compose run --rm lab reset index    Загрузить 10 000 заказов для опыта с индексом (без solution.js)
  docker compose run --rm lab fixtures       Показать контрольные данные, параметры и эталоны без решения
  docker compose run --rm lab data           Проверить валидатор, поиск, историю и отчёт
  docker compose run --rm lab index          Сравнить один запрос до/после индекса на 10 000 заказов
  docker compose run --rm lab purchase       Проверить покупку, откат, повтор и конфликт
  docker compose run --rm lab failover       Сменить primary, прочитать и записать тем же клиентом
  docker compose run --rm lab all            Последовательно выполнить четыре проверки
  docker compose run --rm lab shell          Открыть mongosh для своих запросов
  docker compose down                       Остановить стенд, сохранив данные
  docker compose down --volumes              Удалить контейнеры и данные этого стенда

Каждый сценарий сам готовит свои данные. Выполняйте команды последовательно.
Все результаты и полные explain: results/results.json. Ошибка заменяет прежний PASS.
При изменении solution.js старые результаты отмечаются устаревшими при следующем запуске.
Базы стенда: hw2, hw2_failover. Пока TODO не заполнены, проверки завершаются ошибкой.
URI внутри Docker-сети стенда:
mongodb://m1:27017,m2:27017,m3:27017/hw2?replicaSet=hw2rs&retryWrites=true&serverSelectionTimeoutMS=10000&readPreference=primary`);
  return;
}
if(scenario==='fixtures'){
  log('PRODUCTS',HW.products());log('ORDERS',HW.orders());
  log('SEARCH EXPECTED',[
    {input:{category:'clothes',size:'L',qty:2},ids:['B','C']},
    {input:{category:'clothes',size:'M',qty:5},ids:['A']},
    {input:{category:'accessories',size:'L',qty:3},ids:['D']},
    {input:{category:'clothes',size:'L',qty:99},ids:[]}
  ]);
  log('HISTORY EXPECTED',{input:{userId:2500,status:'paid'},ids:HW.historyExpected});
  log('REPORT EXPECTED',{from:HW.from,to:HW.to,rows:HW.reportExpected});return;
}
const handlers={reset:resetScenario,data:dataScenario,index:indexScenario,purchase:purchaseScenario,failover:failoverScenario};
if(!handlers[scenario]&&scenario!=='all')throw Error('Неизвестная команда. Выполните docker compose run --rm lab help');
const output='/out/results.json';
fs.mkdirSync('/out',{recursive:true});
const results=fs.existsSync(output)?EJSON.parse(fs.readFileSync(output,'utf8')):{dataset:HW.datasetVersion,scenarios:{}};
const solutionHash=require('crypto').createHash('sha256').update(fs.readFileSync('/work/solution.js')).digest('hex');
let current;
const persist=()=>{results.updatedAt=new Date();fs.writeFileSync(output+'.tmp',EJSON.stringify(results,null,2,{relaxed:false})+'\n');fs.renameSync(output+'.tmp',output);};
const save=(name,value)=>{current.artifacts[name]=value;persist();};
for(const entry of Object.values(results.scenarios)){
  if(entry.solutionHash!==solutionHash&&['passed','failed'].includes(entry.status)){
    entry.previousStatus=entry.status;entry.status='outdated';
  }
}
if(scenario==='reset')for(const name of ['data','index','purchase','failover'])results.scenarios[name]={status:'not_run'};
const selected=scenario==='all'?['data','index','purchase','failover']:[scenario];
for(const name of selected)results.scenarios[name]={status:'pending'};
persist();
const ordered=v=>Array.isArray(v)?v.map(ordered):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,ordered(v[k])])):v;
const normalized=v=>ordered(JSON.parse(EJSON.stringify(v,null,0,{relaxed:true})));
const productFields=p=>({_id:p._id,name:p.name,category:p.category,price:p.price,variants:p.variants.map(v=>({size:v.size,stock:v.stock}))});
const orderFields=o=>({_id:o._id,userId:o.userId,createdAt:o.createdAt,status:o.status,items:o.items.map(i=>({sku:i.sku,size:i.size,qty:i.qty,price:i.price}))});
function check(name,condition){ if(!condition) throw Error('FAIL: '+name); current.checks.push(name); persist(); print('PASS '+name); }
function equal(name,a,b){check(name,JSON.stringify(normalized(a))===JSON.stringify(normalized(b)));}
const ids=async result=>(await result).map(x=>x._id);
const cursorIds=async cursor=>(await cursor.toArray()).map(x=>x._id);
const state=async c=>({products:await c.products.find({}).sort({_id:1}).toArray(),orders:await c.orders.find({}).sort({_id:1}).toArray()});
const compact=s=>({stocks:s.products.map(p=>({sku:p._id,variants:p.variants})),orderCount:s.orders.length,orderIds:s.orders.map(x=>x._id)});

async function dataScenario(){
  const c=await HW.reset();
  const installed=await installValidator(c);
  const validatorOptions=(await c.getCollectionInfos({name:'products'}))[0].options;
  check('validator strict/error installed',!!validatorOptions.validator && validatorOptions.validationLevel==='strict' && validatorOptions.validationAction==='error');
  const validation=[];
  for(const [id,mutate,expected] of [
    ['valid',p=>p,0],['string-price',p=>({...p,price:'100.00'}),121],
    ['negative-stock',p=>({...p,variants:[{size:'L',stock:NumberInt(-1)}]}),121]
  ]){
    const product=mutate({...HW.products()[0],_id:id});
    let code=0,details=null;
    try {await c.products.insertOne(product);} catch(e){code=e.code;details=e.errInfo;}
    check('validation '+id,code===expected);
    validation.push({id,code,details});
    if(!code) await c.products.deleteOne({_id:id});
  }
  const options=(await c.getCollectionInfos({name:'products'}))[0].options;
  const searches=[];
  for(const [category,size,qty,expected] of [
    ['clothes','L',2,['B','C']],['clothes','M',5,['A']],
    ['accessories','L',3,['D']],['clothes','L',99,[]]
  ]){
    const documents=await searchProducts(c,{category,size,qty});
    const found=await ids(documents);
    equal('complete product documents '+[category,size,qty].join('/'),documents.map(productFields),(await c.products.find({_id:{$in:expected}}).sort({_id:1}).toArray()).map(productFields));
    equal('search '+[category,size,qty].join('/'),found,expected);
    searches.push({category,size,qty,documents,found,expected});
  }
  await c.products.updateOne({_id:'A','variants.size':'L'},{$set:{'variants.$.stock':NumberInt(2)}});
  const changedDocuments=await searchProducts(c,{category:'clothes',size:'L',qty:2});
  const changed=await ids(changedDocuments);
  equal('L=2 includes A',changed,['A','B','C']);
  searches.push({afterChange:'A/L=2',documents:changedDocuments,found:changed});
  const historyDocuments=await history(c,{userId:2500,status:'paid'});
  const h=await ids(historyDocuments);
  equal('complete history documents',historyDocuments.map(orderFields),HW.historyExpected.map(id=>orderFields(HW.orders().find(o=>o._id===id))));
  equal('history 20 IDs including date ties',h,HW.historyExpected);
  const otherUser=await history(c,{userId:2501,status:'paid'});
  const otherStatus=await history(c,{userId:2500,status:'cancelled'});
  const noHistory=await history(c,{userId:9999,status:'paid'});
  equal('history other user',await ids(otherUser),['other-user']);
  equal('history other status',await ids(otherStatus),['other-status','excluded-cancelled']);
  equal('history no matches',noHistory,[]);
  const table=rows=>rows.map(r=>({sku:r.sku,name:r.name,qty:Number(r.qty),revenue:r.revenue.toString()}));
  const fullReport=await report(c,HW.from,HW.to);
  const actual=table(fullReport);
  equal('report top 5 amounts/order/names',actual,HW.reportExpected);
  const emptyReport={from:ISODate('2024-01-01T00:00:00Z'),to:ISODate('2024-02-01T00:00:00Z')};
  emptyReport.rows=await report(c,emptyReport.from,emptyReport.to);
  equal('empty interval',emptyReport.rows,[]);
  const boundaryReport={from:HW.from,to:ISODate('2026-01-01T00:00:00.001Z')};
  boundaryReport.rows=await report(c,boundaryReport.from,boundaryReport.to);
  equal('from included',table(boundaryReport.rows).map(x=>[x.sku,x.revenue]),[['B','320.00'],['A','200.00']]);
  await c.products.updateOne({_id:'A'},{$set:{price:NumberDecimal('999.00')}});
  const afterPriceReport={from:HW.from,to:HW.to,changedProduct:{sku:'A',price:NumberDecimal('999.00')}};
  afterPriceReport.rows=await report(c,afterPriceReport.from,afterPriceReport.to);
  equal('catalog price does not rewrite revenue',table(afterPriceReport.rows),actual);
  save('data',{options,validation,searches,history:historyDocuments,historyIds:h,otherUser,otherStatus,noHistory,historyExpected:HW.historyExpected,report:fullReport,reportParameters:{from:HW.from,to:HW.to},emptyReport,boundaryReport,afterPriceReport,expected:HW.reportExpected,checks:current.checks});
  log('REPORT: [2026-01-01, 2026-02-01), paid',actual);
  log('REPORT: empty interval',emptyReport);
  log('REPORT: included from boundary',boundaryReport);
  log('REPORT: after catalog price change',afterPriceReport);
  log('HISTORY: userId=2500, status=paid',h);
}

function hasStage(plan,stage){
  if(!plan||typeof plan!=='object')return false;
  if(plan.stage===stage)return true;
  return Object.values(plan).some(v=>Array.isArray(v)?v.some(x=>hasStage(x,stage)):hasStage(v,stage));
}
async function indexScenario(){
  const c=await HW.reset(false);
  const fixture=HW.largeOrders();
  await c.orders.insertMany(fixture,{writeConcern:HW.wc});
  equal('10000 documents',await c.orders.countDocuments({}),10000);
  equal('only _id index initially',(await c.orders.getIndexes()).map(x=>x.name),['_id_']);
  const beforeDocuments=await history(c,{userId:2500,status:'paid'});
  const beforeIds=await ids(beforeDocuments);
  const before=await historyCursor(c,{userId:2500,status:'paid'}).explain('executionStats');
  if(!historyIndex || typeof historyIndex !== 'object') throw new Error('TODO: historyIndex');
  await c.orders.createIndex(historyIndex,{name:'history_user_status_date_id'});
  const after=await historyCursor(c,{userId:2500,status:'paid'}).explain('executionStats');
  const afterDocuments=await history(c,{userId:2500,status:'paid'});
  const afterIds=await ids(afterDocuments);
  equal('same IDs and order',afterIds,beforeIds);
  const expected=fixture.filter(x=>Number(x.userId)===2500&&x.status==='paid')
    .sort((a,b)=>b.createdAt-a.createdAt||(a._id<b._id?-1:a._id>b._id?1:0)).slice(0,20).map(x=>x._id);
  equal('matches independent fixture order',afterIds,expected);
  const row=e=>({nReturned:e.executionStats.nReturned,totalKeysExamined:e.executionStats.totalKeysExamined,
    totalDocsExamined:e.executionStats.totalDocsExamined,hasSORT:hasStage(e.queryPlanner.winningPlan,'SORT')});
  const summary={filter:{userId:2500,status:'paid'},sort:{createdAt:-1,_id:1},index:historyIndex,hint:usesHistoryHint,
    before:row(before),after:row(after),beforeIds,afterIds,beforeDocuments,afterDocuments};
  check('before scans collection + SORT',hasStage(before.queryPlanner.winningPlan,'COLLSCAN')&&summary.before.hasSORT);
  check('after uses IXSCAN without SORT',hasStage(after.queryPlanner.winningPlan,'IXSCAN')&&!summary.after.hasSORT);
  check('examines fewer documents',summary.after.totalDocsExamined<summary.before.totalDocsExamined);
  save('explain-before',before);save('explain-after',after);save('index',summary);
  log('INDEX',{filter:summary.filter,sort:summary.sort,index:summary.index,hint:summary.hint,before:summary.before,after:summary.after});
}

async function purchaseScenario(){
  const c=await HW.reset(false); await installValidator(c);
  const request={operationId:'purchase-001',userId:2500,items:[{sku:'A',size:'M',qty:2},{sku:'B',size:'L',qty:1}]};
  const trace=[];
  const emit=e=>{trace.push(e);log('TX',e);};
  // Нехватка только второго товара: первое изменение реально проходит в транзакции.
  const initial=await state(c);
  const rollbackMeasurement=await measureTransactions('rollback',
    ()=>purchase({...request,operationId:'rollback-001',items:[request.items[0],{sku:'B',size:'L',qty:6}]},emit),save);
  const rollbackError=rollbackMeasurement.error?.code;
  const rolledBack=await state(c);
  check('second item insufficient',rollbackError==='ITEM_UNAVAILABLE');
  check('first update modified before abort',trace[0]?.sku==='A'&&trace[0]?.modified===1);
  check('server observed started and aborted transaction',rollbackMeasurement.evidence.delta.totalStarted>=1&&rollbackMeasurement.evidence.delta.totalAborted>=1);
  equal('abort restores both full documents and leaves no order',rolledBack,initial);
  log('AFTER ABORT',compact(rolledBack));
  const rollback={request:{...request,operationId:'rollback-001',items:[request.items[0],{sku:'B',size:'L',qty:6}]},trace:[...trace],error:rollbackError,before:initial,after:rolledBack};
  trace.length=0;
  const successMeasurement=await measureTransactions('success',()=>purchase(request,emit),save);
  if(successMeasurement.error) throw successMeasurement.error;
  const order=successMeasurement.result;
  check('server observed started and committed transaction',successMeasurement.evidence.delta.totalStarted>=1&&successMeasurement.evidence.delta.totalCommitted>=1);
  const success=await state(c);
  const expected=HW.products();expected[0].variants[1].stock=NumberInt(8);expected[1].variants[0].stock=NumberInt(4);
  equal('success changes only selected stocks',success.products.map(productFields),expected.map(productFields));
  check('exactly one created order',success.orders.length===1&&order._id===request.operationId&&order.status==='created');
  check('userId/date types',Number.isInteger(Number(order.userId))&&Number(order.userId)===request.userId&&order.createdAt instanceof Date);
  equal('snapshot item prices',order.items.map(x=>x.price.toString()),['100.00','80.00']);
  equal('saved items match request in original order',order.items.map(({sku,size,qty})=>({sku,size,qty:Number(qty)})),request.items);
  equal('returned order is saved order',order,success.orders[0]);
  const storedTypes=await c.orders.aggregate([{$match:{_id:request.operationId}},{$project:{userId:{$type:'$userId'},createdAt:{$type:'$createdAt'},items:{$map:{input:'$items',as:'item',in:{qty:{$type:'$$item.qty'},price:{$type:'$$item.price'}}}}}}]).toArray();
  const typeRow=storedTypes[0];
  let correctTypes=!!typeRow&&(typeRow.userId==='int'||typeRow.userId==='long')&&typeRow.createdAt==='date';
  if(typeRow) for(const itemType of typeRow.items) correctTypes=correctTypes&&(itemType.qty==='int'||itemType.qty==='long')&&itemType.price==='decimal';
  check('stored BSON types: integer user/qty, decimal prices, date',correctTypes);
  log('SUCCESS',compact(success));log('SAVED ORDER',order);
  // Цена каталога меняется, порядок ключей запроса меняется: это всё ещё тот же запрос.
  await c.products.updateOne({_id:'A'},{$set:{price:NumberDecimal('777.00')}});
  const beforeReplay=await state(c);
  const replayRequest={userId:2500,items:request.items.map(i=>({qty:i.qty,size:i.size,sku:i.sku})),operationId:request.operationId};
  const replayed=await purchase(replayRequest,emit);
  equal('replay returns original order',replayed,order);
  const afterReplay=await state(c);
  equal('replay no writes despite changed catalog price/key order',afterReplay,beforeReplay);
  log('REPLAY: same order, stocks unchanged',compact(afterReplay));
  let conflictError;
  try {await purchase({...request,items:[{...request.items[0],qty:3},request.items[1]]},emit);}
  catch(e){conflictError=e.code;}
  check('changed qty rejected as request conflict',conflictError==='REQUEST_CONFLICT');
  const afterConflict=await state(c);
  equal('conflict changes nothing',afterConflict,afterReplay);
  // Отсутствующий вариант после первого успешного изменения также отменяет покупку.
  let missingError;
  try {await purchase({...request,operationId:'missing-001',items:[request.items[0],{sku:'B',size:'XXL',qty:1}]},emit);}
  catch(e){missingError=e.code;}
  check('missing variant rejected',missingError==='ITEM_UNAVAILABLE');
  equal('missing variant rollback',await state(c),afterReplay);
  let unknownError;
  try {await purchase({...request,operationId:'unknown-001',items:[request.items[0],{sku:'NO_SUCH_SKU',size:'L',qty:1}]},emit);}
  catch(e){unknownError=e.code;}
  check('unknown SKU rejected',unknownError==='ITEM_UNAVAILABLE');
  equal('unknown SKU rollback',await state(c),afterReplay);
  save('purchase',{request,rollback,success:{order,state:success},replay:{order:replayed,before:beforeReplay,after:afterReplay},conflict:{error:conflictError,after:afterConflict},missingError,unknownError,trace,checks:current.checks});
}

async function failoverScenario(){
  const client=db.getMongo(); // Единственный экземпляр на весь опыт, seed list + replicaSet.
  const c=client.getDB('hw2_failover');
  await c.dropDatabase();await c.createCollection('probe');
  const roles=async()=>{
    const s=await c.adminCommand({replSetGetStatus:1});
    return s.members.map(m=>({host:m.name,role:m.stateStr}));
  };
  const before=await roles();
  check('3 data-bearing nodes ready',before.length===3&&before.filter(x=>x.role==='PRIMARY').length===1&&before.filter(x=>x.role==='SECONDARY').length===2);
  const oldPrimary=before.find(x=>x.role==='PRIMARY').host;
  const firstWrite=await writeProbe(c,'before','majority confirmed before stepDown');
  check('first majority write acknowledged',firstWrite?.acknowledged===true);
  log('ROLES BEFORE',before);log('FIRST WRITE',firstWrite);
  let stepDown;
  try {stepDown=await c.adminCommand({replSetStepDown:60,secondaryCatchUpPeriodSecs:10});}
  catch(e){stepDown={message:e.message,code:e.code};}
  const retries=[];let after,read,newWrite;
  for(let i=0;i<60;i++){
    try{
      after=await roles();
      const p=after.find(x=>x.role==='PRIMARY');
      if(!p||p.host===oldPrimary||after.filter(x=>x.role==='SECONDARY').length!==2)throw Error('Waiting for changed primary and two secondaries');
      read=await readProbe(c,'before');
      // upsert делает повтор этой тестовой записи безопасным при потере ответа.
      newWrite=await writeProbe(c,'after','majority confirmed after stepDown');
      break;
    }catch(e){retries.push({attempt:i+1,error:e.message});await sleep(500);}
  }
  check('primary actually changed',!!after&&after.some(x=>x.role==='PRIMARY'&&x.host!==oldPrimary));
  check('same client instance',client===db.getMongo());
  check('old majority document read',read?.message==='majority confirmed before stepDown');
  check('new majority write acknowledged',newWrite?.acknowledged===true);
  equal('both documents present',await c.probe.countDocuments({}),2);
  const result={connection:'mongodb://m1:27017,m2:27017,m3:27017/hw2?replicaSet=hw2rs',sameClient:true,writeConcern:HW.wc,before,firstWrite,stepDown,retries,after,read,newWrite,documents:await c.probe.find({}).sort({_id:1}).toArray(),checks:current.checks};
  save('failover',result);log('ROLES AFTER',after);log('READ OLD DOCUMENT',read);log('NEW WRITE',newWrite);
}

async function resetScenario(){
  const mode=process.env.HW_DATASET||'data';
  if(!['data','index'].includes(mode))throw Error('Используйте lab reset или lab reset index');
  const c=await HW.reset(mode==='data');
  if(mode==='index')await c.orders.insertMany(HW.largeOrders(),{writeConcern:HW.wc});
  const products=await c.products.countDocuments({}),orders=await c.orders.countDocuments({});
  save('reset',{datasetVersion:HW.datasetVersion,mode,products,orders});
  check('fixtures loaded',products===6&&orders===(mode==='index'?10000:35));
  log('DATASET',{mode,products,orders});
}

let loaded=false;
for(const name of selected){
  current=results.scenarios[name]={status:'running',startedAt:new Date(),solutionHash,checks:[],artifacts:{}};
  persist();
  try{
    current.server=await db.version();
    if(current.server!=='8.0.30')throw Error('Нужна MongoDB 8.0.30, получена '+current.server);
    if(name!=='reset'&&!loaded){await load('/work/solution.js');loaded=true;}
    log('RUN '+name,{dataset:HW.datasetVersion,startedAt:current.startedAt,server:current.server});
    await handlers[name]();
    current.status='passed';current.finishedAt=new Date();persist();
    log('COMPLETE '+name,{passed:current.checks.length,results:'results/results.json'});
  }catch(e){
    current.status='failed';current.finishedAt=new Date();current.error={message:e.message,code:e.code||null};persist();
    throw e;
  }
}

})().catch(e=>{console.error(e);quit(1);});
