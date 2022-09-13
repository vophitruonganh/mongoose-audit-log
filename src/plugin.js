const deepDiff = require('deep-diff');
const Audit = require('./model');
const mongoose = require("mongoose");

const filter = (path, key) => path.length === 0 && ~['_id', '__v', 'createdAt', 'updatedAt'].indexOf(key);

const isEmpty = (value) =>
	value === undefined ||
	value === null ||
	(typeof value === 'object' && Object.keys(value).length === 0) ||
	(typeof value === 'string' && value.trim().length === 0);

const types = {
	add: 'Add',
	edit: 'Edit',
	delete: 'Delete'
};

const extractArray = (data, path) => {
	if (path.length === 1) return data[path[0]];

	const parts = [].concat(path);
	const last = parts.pop();

	const value = parts.reduce((current, part) => {
		return current ? current[part] : undefined;
	}, data);

	return value ? value[last] : undefined;
};


const getUserAction = (currentObject) => currentObject.__user || module.exports.getUser();

const flattenObject = (obj) => Object.keys(obj).reduce((data, key) => {
	if (key.indexOf('$') === 0) {
		Object.assign(data, obj[key]);
	} else {
		data[key] = obj[key];
	}
	return data;
}, {});

const getDiffData = (original, currentObject, filter) => {
	return deepDiff(
		JSON.parse(JSON.stringify(original)),
		JSON.parse(JSON.stringify(currentObject)),
		filter
	);
};

const addAuditLogObject = (currentObject, original, action, options = {}) => {
	const user = getUserAction(currentObject);
	if (!user) throw new Error('User missing in audit log!');

	delete currentObject.__user;

	const newCurrentObject = currentObject?.docs || currentObject;

	const changes = getDiffData(original, newCurrentObject, filter);

	const auditLog = buildAuditLog(newCurrentObject, original, changes, user, action);
	return changes && changes.length ? storeAuditLog(auditLog, options) : Promise.resolve();
};

const buildAuditLog = (currentObject, original, changes, user, action) => {
	return {
		itemId: currentObject?._id || null,
		itemName: original?.modelName || currentObject?.constructor?.modelName,
		action: action || null,
		changes: changes?.reduce((obj, change) => {
			const key = (change?.path || ['newObject'])?.join('_');

			switch (change?.kind) {
				case 'D':
					handleAudits(change?.lhs, 'from', types.delete, obj, key);
					break;
				case 'N':
					handleAudits(change?.rhs, 'to', types.add, obj, key);
					break;
				case 'A':
					if (!obj[key] && change?.path?.length) {
						const data = {
							from: extractArray(original, change?.path),
							to: extractArray(currentObject, change?.path)
						};

						if (data.from.length && data.to.length) {
							data.type = types.edit;
						} else if (data.from.length) {
							data.type = types.delete;
						} else if (data.to.length) {
							data.type = types.add;
						}

						obj[key] = data;
					}

					break;
				default:
					obj[key] = {
						from: change.lhs,
						to: change.rhs,
						type: types.edit
					};
					break;
			}
			;
			return obj;
		}, {}),
		originalDocument: original || {},
		user
	};
};

const storeAuditLog = async (data, options = {}) => {
	try {
		if (options?.hasStorage) new Audit(data).save();
		else console.log(data);
		return Promise.resolve();
	} catch (error) {
		console.error('storeAuditLog', error);
		return Promise.resolve();
	}
};

const handleAudits = (changes, target, type, obj, key) => {
	if (typeof changes === 'object' && changes !== null) {
		if (Object.keys(changes).filter(key => key === '_id' || key === 'id').length) {
			obj[key] = {[target]: changes, type};
		} else {
			Object.entries(changes).forEach(([sub, value]) => {
				if (!isEmpty(value)) obj[`${key}_${sub}`] = {[target]: value, type};
			});
		}
	} else {
		// primitive value
		obj[key] = {[target]: changes, type};
	}
};

const addAuditLog = (currentObject, action, next, options = {}) => {
	currentObject.constructor
		.findOne({_id: currentObject._id})
		.then(original => addAuditLogObject(currentObject, original, action, options))
		.then(() => next())
		.catch(next);
};


const addUpdate = (query, action, next, multi, options = {}) => {
	const updated = flattenObject(query?._update);
	let counter = 0;

	return query.find(query?._conditions)
		.lean(true)
		.cursor()
		.eachAsync(fromDb => {
			if (!multi && counter++) return next();

			const orig = Object.assign({__user: query.options.__user}, fromDb, updated);

			orig.constructor.modelName = query?._collection.collectionName;
			return addAuditLogObject(orig, fromDb, action, options);
		})
		.then(() => next())
		.catch(next);
};

const addDelete = (currentObject, options, action, next) => {
	const orig = Object.assign({}, currentObject._doc || currentObject);
	orig.constructor.modelName = currentObject.constructor?.modelName;

	return addAuditLogObject({
		_id: currentObject?._id,
		__user: options?.__user
	}, orig, action, options)
		.then(() => next())
		.catch(next);
};

const addInsert = (currentObject, options, action, next) => {
	const orig = Object.assign({}, currentObject?._doc || currentObject);
	orig.constructor.modelName = currentObject.constructor?.modelName;

	return addAuditLogObject({
		_id: currentObject?._id,
		__user: options?.__user,
	}, orig, action, options)
		.then(() => next())
		.catch(next);
};

const addInsertMany = (currentObject, docs, options, action, next) => {
	const orig = Object.assign({}, [] || currentObject);
	orig.constructor.modelName = currentObject.modelName;

	return addAuditLogObject({
		_id: currentObject._id,
		__user: options.__user,
		docs: docs
	}, orig, action, options)
		.then(next)
		.catch(next);
};

const addFindAndDelete = (query, action, next, options = {}) => {
	query.find()
		.lean(true).cursor()
		.eachAsync(fromDb => {
			return addDelete(
				fromDb,
				Object.assign({}, query.options, options),
				action,
				next
			);
		})
		.then(next)
		.catch(next);
};

const plugin = function Audit(schema, options = {}) {
	let hasStorage = false;

	if (options?.connectionString) {
		mongoose.connect(options?.connectionString);
		hasStorage = true;
	}

	schema.pre('save', function (next) {
		// if (this.isNew) return next();
		addAuditLog(this, 'save', next, {hasStorage});
	});

	schema.pre('update', function (next) {
		addUpdate(this, 'update', next, !!this.options.multi, {hasStorage});
	});

	schema.pre('updateOne', function (next) {
		addUpdate(this, 'updateOne', next, false, {hasStorage});
	});

	schema.pre('findOneAndUpdate', function (next) {
		addUpdate(this, 'findOneAndUpdate', next, false, {hasStorage});
	});

	schema.pre('updateMany', function (next) {
		addUpdate(this, 'updateMany', next, true, {hasStorage});
	});

	schema.pre('replaceOne', function (next) {
		addUpdate(this, 'replaceOne', next, false, {hasStorage});
	});

	schema.pre('remove', function (next, options) {
		addDelete(this, {hasStorage}, 'remove', next);
	});

	schema.pre('findOneAndDelete', function (next) {
		addFindAndDelete(this, 'findOneAndDelete', next, {hasStorage});
	});

	schema.pre('findOneAndRemove', function (next) {
		addFindAndDelete(this, 'findOneAndRemove', next, {hasStorage});
	});

	schema.pre('deleteMany', function (next) { addFindAndDelete(this, 'deleteMany', next, {hasStorage});});

	schema.pre('insert', function (next) { addInsert(this, {hasStorage}, 'insert', next);});

	schema.pre('insertMany', function (next, docs) {
		addInsertMany(this, docs, {hasStorage}, 'insertMany', next);
	});
};

module.exports = plugin;
module.exports.getUser = () => undefined;
