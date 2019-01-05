const ServiceLocator = require('catberry-locator');
const StoreFinder = require('catberry/lib/finders/StoreFinder.js');
const ComponentsFinder = require('catberry/lib/finders/ComponentFinder.js');
const StoreLoader = require('catberry/lib/loaders/StoreLoader.js');
const ComponentsLoader = require('catberry/lib/loaders/ComponentLoader.js');
const events = require('events');
const assert = require('assert');
const fs = require('fs');
const rimraf = require('rimraf');
const path = require('path');
const uuid = require('uuid');
const mkdir = require('mkdirp');
const {ncp} = require('ncp');

const Watcher = require('../../index.js');

function promisify(methodWithCallback) {
	return (...args) =>
		new Promise((resolve, reject) => {
			args.push((error, result) => error ? reject(error) : resolve(result));
			methodWithCallback.apply(this, args);
		});
}

const copy = promisify(ncp);
const remove = promisify(rimraf);
const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);

const CASE_PATH = path.join(
	'test', 'cases', 'lib', 'finders'
);
const CASE_COMPONENTS_PATH = path.join(CASE_PATH, 'ComponentFinder', 'components');
const CASE_STORES_PATH = path.join(CASE_PATH, 'StoreFinder', 'catberry_stores');

function getTemporaryPath() {
	return path.join(CASE_PATH, `__tmp__${uuid.v4()}`);
}

describe('Watcher', () => {
	let locator, watcher;

	beforeEach(() => {
		locator = new ServiceLocator();
		locator.registerInstance('serviceLocator', locator);
		locator.registerInstance('eventBus', new events.EventEmitter());
		locator.register('storeFinder', StoreFinder);
		locator.register('componentFinder', ComponentsFinder);
		locator.register('storeLoader', StoreLoader);
		locator.register('componentLoader', ComponentsLoader);

		locator.registerInstance('config', {
			componentsGlob: [
				`${CASE_COMPONENTS_PATH}/test1/**/test-cat-component.json`,
				`${CASE_COMPONENTS_PATH}/test1/test-cat-component.json`,
				`${CASE_COMPONENTS_PATH}/test3/**/test-cat-component.json`,
				`${CASE_COMPONENTS_PATH}/test3/test-cat-component.json`
			],
			storesDirectory: CASE_STORES_PATH
		});

		watcher = new Watcher(locator);
		console.log(watcher);
	});

	afterEach(() => watcher.closeWatch());

	describe('ComponentFinder', () => {
		let finder, temporaryRoot;

		const caseRoot = path.join(CASE_PATH, 'ComponentFinder', 'watch');

		beforeEach(() => {
			temporaryRoot = getTemporaryPath();
			locator.registerInstance('config', {
				componentsGlob: `${temporaryRoot}/**/test-cat-component.json`
			});
			finder = locator.resolve('componentFinder');
		});

		afterEach(() => remove(temporaryRoot));

		it('should trigger add event when a new component appears', done => {
			const insidePath = path.join(caseRoot, 'inside');
			const anotherPath = path.join(caseRoot, 'another');
			const anotherDestination = path.join(temporaryRoot, 'another');

			copy(insidePath, temporaryRoot)
				.then(() => finder.find())
				.then(() => watcher.watch())
				.then(() => {
					finder.once('add', foundDescription => {
						assert.deepEqual(foundDescription, {
							name: 'another',
							path: path.join(anotherDestination, 'test-cat-component.json'),
							properties: {
								name: 'another',
								logic: './index.js',
								template: 'test1.html',
								errorTemplate: 'error.html',
								additional: 'some'
							}
						});
						done();
					});

					return copy(anotherPath, anotherDestination);
				})
				.catch(done);
		});

		it('should trigger unlink/add events when component.json is changed', done => {
			const insidePath = path.join(caseRoot, 'inside');
			const catComponent = path.join(temporaryRoot, 'test-cat-component.json');

			copy(insidePath, temporaryRoot)
				.then(() => finder.find())
				.then(() => watcher.watch())
				.then(() => {
					let isUnlinked = false;
					finder.once('unlink', unlinkedDescription => {
						assert.deepEqual(unlinkedDescription, {
							name: 'inside',
							path: catComponent,
							properties: {
								name: 'Inside',
								logic: './logic.js',
								template: 'cool.html',
								additional: 'some2'
							}
						});
						isUnlinked = true;
					});

					finder.once('add', foundDescription => {
						assert.deepEqual(foundDescription, {
							name: 'inside',
							path: catComponent,
							properties: {
								name: 'Inside',
								logic: './logic.js',
								template: 'cool.html',
								additional: 'newImportantValue'
							}
						});
						assert.strictEqual(isUnlinked, true);
						done();
					});

					return readFile(catComponent);
				})
				.then(file => {
					const content = JSON.parse(file);
					content.additional = 'newImportantValue';
					return writeFile(catComponent, JSON.stringify(content));
				})
				.catch(done);
		});

		it('should trigger unlink events when component.json is removed', done => {
			const insidePath = path.join(caseRoot, 'inside');
			const catComponent = path.join(temporaryRoot, 'test-cat-component.json');

			copy(insidePath, temporaryRoot)
				.then(() => finder.find())
				.then(() => watcher.watch())
				.then(() => {
					finder.once('unlink', unlinkedDescription => {
						assert.deepEqual(unlinkedDescription, {
							name: 'inside',
							path: catComponent,
							properties: {
								name: 'Inside',
								logic: './logic.js',
								template: 'cool.html',
								additional: 'some2'
							}
						});
						done();
					});

					return remove(catComponent);
				})
				.catch(done);
		});

		it('should trigger change event when a JavaScript file of the component changes', done => {
			const componentPath = path.join(caseRoot, 'another');
			const catLogic = path.join(temporaryRoot, 'index.js');
			const catComponent = path.join(temporaryRoot, 'test-cat-component.json');

			copy(componentPath, temporaryRoot)
				.then(() => finder.find())
				.then(() => watcher.watch())
				.then(() => {
					finder.once('change', changedArgs => {
						assert.deepEqual(changedArgs, {
							filename: catLogic,
							component: {
								name: 'another',
								path: catComponent,
								properties: {
									name: 'another',
									logic: './index.js',
									template: 'test1.html',
									errorTemplate: 'error.html',
									additional: 'some'
								}
							}
						});
						done();
					});

					return readFile(catLogic);
				})
				.then(file => {
					const modified = `${file}\nfunction() {}`;
					return writeFile(catLogic, modified);
				})
				.catch(done);
		});

		it('should trigger change event when a template file of the component changes', done => {
			const componentPath = path.join(caseRoot, 'another');
			const catTemplate = path.join(temporaryRoot, 'test1.html');
			const catComponent = path.join(temporaryRoot, 'test-cat-component.json');

			copy(componentPath, temporaryRoot)
				.then(() => finder.find())
				.then(() => watcher.watch())
				.then(() => {
					finder.once('change', changedArgs => {
						assert.deepEqual(changedArgs, {
							filename: catTemplate,
							component: {
								name: 'another',
								path: catComponent,
								properties: {
									name: 'another',
									logic: './index.js',
									template: 'test1.html',
									errorTemplate: 'error.html',
									additional: 'some'
								}
							}
						});
						done();
					});

					return readFile(catTemplate);
				})
				.then(file => {
					const modified = `${file}\n<h1>Hi!</h1>`;
					return writeFile(catTemplate, modified);
				})
				.catch(done);
		});

		it('should trigger change event when an error template file of the component changes', done => {
			const componentPath = path.join(caseRoot, 'another');
			const catTemplate = path.join(temporaryRoot, 'error.html');
			const catComponent = path.join(temporaryRoot, 'test-cat-component.json');

			copy(componentPath, temporaryRoot)
				.then(() => finder.find())
				.then(() => watcher.watch())
				.then(() => {
					finder.once('change', changedArgs => {
						assert.deepEqual(changedArgs, {
							filename: catTemplate,
							component: {
								name: 'another',
								path: catComponent,
								properties: {
									name: 'another',
									logic: './index.js',
									template: 'test1.html',
									errorTemplate: 'error.html',
									additional: 'some'
								}
							}
						});
						done();
					});

					return readFile(catTemplate);
				})
				.then(file => {
					const modified = `${file}\n<h1>Hi!</h1>`;
					return writeFile(catTemplate, modified);
				})
				.catch(done);
		});

		it('should trigger change event when a JavaScript file is removed', done => {
			const componentPath = path.join(caseRoot, 'another');
			const catLogic = path.join(temporaryRoot, 'index.js');
			const catComponent = path.join(temporaryRoot, 'test-cat-component.json');

			copy(componentPath, temporaryRoot)
				.then(() => finder.find())
				.then(() => watcher.watch())
				.then(() => {
					finder.once('change', changedArgs => {
						assert.deepEqual(changedArgs, {
							filename: catLogic,
							component: {
								name: 'another',
								path: catComponent,
								properties: {
									name: 'another',
									logic: './index.js',
									template: 'test1.html',
									errorTemplate: 'error.html',
									additional: 'some'
								}
							}
						});
						done();
					});
					return remove(catLogic);
				})
				.catch(done);
		});

		it('should trigger change event when a template file is removed', done => {
			const componentPath = path.join(caseRoot, 'another');
			const catTemplate = path.join(temporaryRoot, 'test1.html');
			const catComponent = path.join(temporaryRoot, 'test-cat-component.json');

			copy(componentPath, temporaryRoot)
				.then(() => finder.find())
				.then(() => watcher.watch())
				.then(() => {
					finder.once('change', changedArgs => {
						assert.deepEqual(changedArgs, {
							filename: catTemplate,
							component: {
								name: 'another',
								path: catComponent,
								properties: {
									name: 'another',
									logic: './index.js',
									template: 'test1.html',
									errorTemplate: 'error.html',
									additional: 'some'
								}
							}
						});
						done();
					});
					return remove(catTemplate);
				})
				.catch(done);
		});

		it('should trigger change event when an error template file is removed', done => {
			const componentPath = path.join(caseRoot, 'another');
			const catTemplate = path.join(temporaryRoot, 'error.html');
			const catComponent = path.join(temporaryRoot, 'test-cat-component.json');

			copy(componentPath, temporaryRoot)
				.then(() => finder.find())
				.then(() => watcher.watch())
				.then(() => {
					finder.once('change', changedArgs => {
						assert.deepEqual(changedArgs, {
							filename: catTemplate,
							component: {
								name: 'another',
								path: catComponent,
								properties: {
									name: 'another',
									logic: './index.js',
									template: 'test1.html',
									errorTemplate: 'error.html',
									additional: 'some'
								}
							}
						});
						done();
					});
					return remove(catTemplate);
				})
				.catch(done);
		});

		it('should trigger change event when a file appears in the component directory', done => {
			const componentPath = path.join(caseRoot, 'another');
			const catFile = path.join(temporaryRoot, 'file.html');
			const catComponent = path.join(temporaryRoot, 'test-cat-component.json');

			copy(componentPath, temporaryRoot)
				.then(() => finder.find())
				.then(() => watcher.watch())
				.then(() => {
					finder.once('change', changedArgs => {
						assert.deepEqual(changedArgs, {
							filename: catFile,
							component: {
								name: 'another',
								path: catComponent,
								properties: {
									name: 'another',
									logic: './index.js',
									template: 'test1.html',
									errorTemplate: 'error.html',
									additional: 'some'
								}
							}
						});
						done();
					});
					return writeFile(catFile, 'some');
				})
				.catch(done);
		});

		it('should trigger change event when a file changes in the component directory', done => {
			const componentPath = path.join(caseRoot, 'another');
			const catFile = path.join(temporaryRoot, 'just-file.html');
			const catComponent = path.join(temporaryRoot, 'test-cat-component.json');

			copy(componentPath, temporaryRoot)
				.then(() => finder.find())
				.then(() => watcher.watch())
				.then(() => {
					finder.once('change', changedArgs => {
						assert.deepEqual(changedArgs, {
							filename: catFile,
							component: {
								name: 'another',
								path: catComponent,
								properties: {
									name: 'another',
									logic: './index.js',
									template: 'test1.html',
									errorTemplate: 'error.html',
									additional: 'some'
								}
							}
						});
						done();
					});
					return readFile(catFile);
				})
				.then(file => {
					const modified = `${file}\n<h1>Hi!</h1>`;
					return writeFile(catFile, modified);
				})
				.catch(done);
		});

	});

	describe('StoreFinder', () => {
		let finder, temporaryRoot;

		const caseRoot = path.join(CASE_PATH, 'StoreFinder', 'watch');

		beforeEach(() => {
			temporaryRoot = getTemporaryPath();
			locator.registerInstance('config', {
				storesDirectory: temporaryRoot
			});
			finder = locator.resolve('storeFinder');
			return mkdir(temporaryRoot);
		});

		afterEach(() => remove(temporaryRoot));

		it('should trigger add event when a new store appears', done => {
			const storePath = path.join(caseRoot, 'Store.js');
			const storeDestination = path.join(temporaryRoot, 'Store.js');

			finder.find()
				.then(() => watcher.watch())
				.then(() => {
					finder.once('add', foundDescription => {
						assert.deepEqual(foundDescription, {
							name: 'Store',
							path: storeDestination
						});
						done();
					});

					return copy(storePath, storeDestination);
				})
				.catch(done);
		});

		it('should trigger unlink event when a store is removed', done => {
			const storePath = path.join(caseRoot, 'Store.js');
			const storeDestination = path.join(temporaryRoot, 'Store.js');

			finder.find()
				.then(() => copy(storePath, storeDestination))
				.then(() => watcher.watch())
				.then(() => {
					finder.once('unlink', unlinkDescription => {
						assert.deepEqual(unlinkDescription, {
							name: 'Store',
							path: storeDestination
						});
						done();
					});

					return remove(storeDestination);
				})
				.catch(done);
		});

		it('should trigger change event when a store changed', done => {
			const storePath = path.join(caseRoot, 'Store.js');
			const storeDestination = path.join(temporaryRoot, 'Store.js');

			finder.find()
				.then(() => copy(storePath, storeDestination))
				.then(() => watcher.watch())
				.then(() => {
					finder.once('change', changeDescription => {
						assert.deepEqual(changeDescription, {
							name: 'Store',
							path: storeDestination
						});
						done();
					});

					return readFile(storeDestination);
				})
				.then(file => {
					const modified = `${file}\nfunction() { }`;
					return writeFile(storeDestination, modified);
				})
				.catch(done);
		});

	});
});
