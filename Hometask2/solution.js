// Заполняйте TODO. c — переданная база; функции выполняют реальные запросы MongoDB.
// Служебный lab.js менять не требуется. Контракты и порядок опытов — в Задание.md.
globalThis.installValidator = async c => {
  const schema = {
    bsonType: 'object',
    required: ['_id', 'name', 'category', 'price', 'variants'],
    properties: {
      _id: {bsonType: 'string'},
      name: {bsonType: 'string'},
      category: {bsonType: 'string'},
      price: {bsonType: 'decimal', minimum: 0},
      variants: {
        bsonType: 'array',
        items: {
          bsonType: 'object',
          required: ['size', 'stock'],
          properties: {
            size: {bsonType: 'string'},
            stock: {bsonType: ['int', 'long'], minimum: 0}
          }
        }
      }
    }
  };
  // Размеры внутри товара не повторяются: уникальных размеров столько же, сколько вариантов.
  // $cond нужен на случай, если variants не массив: тогда $size упал бы с ошибкой.
  const uniqueSizes = {$expr: {$cond: [
        {$isArray: '$variants'},
        {$eq: [{$size: {$setUnion: ['$variants.size']}}, {$size: '$variants'}]},
        false
      ]}};
  return c.runCommand({
    collMod: 'products',
    validator: {$and: [{$jsonSchema: schema}, uniqueSizes]},
    validationLevel: 'strict',
    validationAction: 'error'
  });
};

// Возврат: Promise массива полных Product; порядок _id ASC; [] при отсутствии.
globalThis.searchProducts = async (c, {category, size, qty}) => {
  // $elemMatch: размер и достаточный остаток должны быть в одном варианте.
  return c.products.find({
    category,
    variants: {$elemMatch: {size, stock: {$gte: qty}}}
  }).sort({_id: 1}).toArray();
};

// Технический helper: верните MongoDB cursor с фильтром, сортировкой и limit.
// Один и тот же запрос используется для результата и explain в опыте с индексом.
globalThis.historyCursor = (c, {userId, status}) => {
  // _id — второй ключ сортировки: однозначный порядок при равных датах.
  return c.orders.find({userId, status}).sort({createdAt: -1, _id: 1}).limit(20);
};
globalThis.history = async (c, input) => historyCursor(c, input).toArray();

// Заполните порядок полей и направления индекса для historyCursor.
// ESR: сначала равенства (userId, status), затем сортировка (createdAt ↓, _id ↑).
globalThis.historyIndex = {userId: 1, status: 1, createdAt: -1, _id: 1};
// Если добавили hint в historyCursor, измените флаг на true.
globalThis.usesHistoryHint = false;

// Возврат: Promise массива {sku, name, qty, revenue}; revenue — Decimal128.
globalThis.report = async (c, from, to) => {
  return c.orders.aggregate([
    // 1. Только оплаченные заказы за [from, to): начало включаем, конец исключаем.
    {$match: {status: 'paid', createdAt: {$gte: from, $lt: to}}},
    // 2. Один документ на каждую позицию заказа.
    {$unwind: '$items'},
    // 3. Объединяем размеры одного товара; цена берётся из позиции заказа.
    {$group: {
        _id: '$items.sku',
        qty: {$sum: '$items.qty'},
        revenue: {$sum: {$multiply: ['$items.qty', '$items.price']}}
      }},
    // 4–5. Выручка по убыванию, при равенстве — артикул по возрастанию; топ-5.
    {$sort: {revenue: -1, _id: 1}},
    {$limit: 5},
    // 6. Название товара из каталога.
    {$lookup: {from: 'products', localField: '_id', foreignField: '_id', as: 'product'}},
    // 7. Итоговый вид строки.
    {$project: {_id: 0, sku: '$_id', name: {$first: '$product.name'}, qty: 1, revenue: 1}}
  ]).toArray();
};

// request: {operationId, userId, items:[{sku,size,qty},{sku,size,qty}]}.
// Входы соответствуют контракту задания. Два SKU различны; порядок items значим.
// Возврат: Promise созданного или ранее сохранённого Order.
// При отказе: throw HWError('ITEM_UNAVAILABLE') или HWError('REQUEST_CONFLICT').
// Сообщение ошибки свободное; сценарий проверяет только error.code.
// transaction(body) предоставлена: body получает c — базу в активной сессии.
// Все операции покупки внутри body выполняйте через этот c.
// Тот же бизнес-запрос: совпадают userId и позиции (sku, size, qty) в том же порядке.
// Сравниваем значения, а не JSON: порядок ключей и тип числа (int/double) не важны.
const sameRequest = (order, {userId, items}) =>
    Number(order.userId) === Number(userId) &&
    order.items.length === items.length &&
    order.items.every((saved, i) =>
        saved.sku === items[i].sku &&
        saved.size === items[i].size &&
        Number(saved.qty) === Number(items[i].qty));

globalThis.purchase = async (request, trace = () => {}) => {
  return transaction(async c => {
    // Повтор: _id заказа = operationId. Если заказ уже есть — списаний не делаем.
    const existing = await c.orders.findOne({_id: request.operationId});
    if (existing) {
      if (sameRequest(existing, request)) return existing;
      throw HWError('REQUEST_CONFLICT');
    }

    const items = [];
    for (const {sku, size, qty} of request.items) {
      // Проверка остатка входит в условие обновления; $ — найденный вариант.
      const r = await c.products.updateOne(
          {_id: sku, variants: {$elemMatch: {size, stock: {$gte: qty}}}},
          {$inc: {'variants.$.stock': NumberInt(-qty)}}
      );
      trace({event: 'update_inside_transaction', sku,
        matched: r.matchedCount, modified: r.modifiedCount});
      // Исключение → оболочка transaction() делает abort и отменяет все изменения.
      if (r.modifiedCount !== 1) throw HWError('ITEM_UNAVAILABLE');

      // Цена покупки — текущая цена каталога, прочитанная в той же транзакции.
      const product = await c.products.findOne({_id: sku}, {price: 1});
      items.push({sku, size, qty: NumberInt(qty), price: product.price});
    }

    const order = {
      _id: request.operationId,
      userId: NumberInt(request.userId),
      createdAt: new Date(),
      status: 'created',
      items
    };
    await c.orders.insertOne(order);
    return order;
  });
};

// Используйте именно переданный c: он связан с одним MongoDB-клиентом опыта.
// writeProbe: сохранить {_id:id, message} в c.probe с majority и j:true.
// Возврат — результат записи с acknowledged:true. Повтор вызова с тем же id
// должен быть безопасен: оболочка опыта может повторить запись после ошибки связи.
globalThis.writeProbe = async (c, id, message) => {
  // replaceOne + upsert: повтор после обрыва связи перезапишет тот же документ, а не создаст дубль.
  return c.probe.replaceOne(
      {_id: id},
      {_id: id, message},
      {upsert: true, writeConcern: {w: 'majority', j: true, wtimeout: 10000}}
  );
};
// Возврат — документ c.probe с указанным _id либо null.
globalThis.readProbe = async (c, id) => {
  // Чтение с primary с readConcern majority; null, если документа нет.
  return c.probe.findOne({_id: id}, {}, {readConcern: {level: 'majority'}});
};
