const path = require('path');
const chokidar = require('chokidar');
const {EventEmitter} = require('events');

const CHOKIDAR_OPTIONS = {
	ignoreInitial: true,
	useFsEvents: false,
	cwd: process.cwd(),
	ignorePermissionErrors: true
};

class Watcher extends EventEmitter {
	constructor(locator) {
		super();

		/**
		 * Current event bus.
		 *
		 * @type {EventEmitter}
		 */
		this.eventBus = locator.resolve('eventBus');

		/**
		 * Current store finder.
		 *
		 * @type {StoreFinder}
		 */
		this.storeFinder = locator.resolve('storeFinder');

		/**
		 * Current store loader.
		 *
		 * @type {StoreLoader}
		 */
		this.storeLoader = locator.resolve('storeLoader');

		/**
		 * Current store finder.
		 *
		 * @type {ComponentFinder}
		 */
		this.componentFinder = locator.resolve('componentFinder');

		/**
		 * Current store loader.
		 *
		 * @type {ComponentLoader}
		 */
		this.componentLoader = locator.resolve('componentLoader');

		this.componentLogicWatcher = null;
		this.watchers = [];

		this.allStoresLoaded = false;

		this.eventBus.once('allStoresLoaded', () => (this.allStoresLoaded = true));
	}

	watch() {
		this.logProcesses();

		return Promise
			.all([
				this.watchStores(),
				this.watchComponents()
			])
			.then(([storeWatcher, watchers]) => [storeWatcher, ...watchers]);
	}

	closeWatch() {
		for (const watcher of this.watchers) {
			watcher.closeWatch();
		}
	}

	logProcesses() {
		this.eventBus.emit('info', 'Watching stores and components for changes...');

		this
			.on('addStore', storeDetails =>
				this.eventBus.emit('info', `Store "${storeDetails.path}" has been added, initializing...`)
			)
			.on('changeStore', storeDetails =>
				this.eventBus.emit('info', `Store "${storeDetails.path}" has been changed, reinitializing...`)
			)
			.on('unlinkStore', storeDetails =>
				this.eventBus.emit('info', `Store "${storeDetails.path}" has been unlinked, removing...`)
			)
			.on('reloadStore', storeDetails =>
				this.eventBus.emit('info', `Store "${storeDetails.path}" has been reloaded`)
			)
			.on('addComponent', componentDetails =>
				this.eventBus.emit('info', `Component "${componentDetails.path}" has been added, initializing...`)
			)
			.on('changeComponent', componentDetails =>
				this.eventBus.emit('info', `Component "${componentDetails.path}" has been changed, reinitializing...`)
			)
			.on('changeLogic', componentDetails =>
				this.eventBus.emit('info', `Logic file of component "${componentDetails.path}" has been changed, reinitializing...`)
			)
			.on('changeTemplates', componentDetails =>
				this.eventBus.emit('info', `Templates of component "${componentDetails.path}" has been changed, reinitializing...`)
			)
			.on('unlinkComponent', componentDetails =>
				this.eventBus.emit('info', `Component "${componentDetails.path}" has been unlinked, removing...`)
			);
	}

	/**
	 * Watches the components for changing.
	 *
	 * @return {Promise} Promise of ready watchers.
	 */
	watchStores() {
		const fileWatcher = chokidar.watch(this.storeFinder.getStoresGlobExpression(), CHOKIDAR_OPTIONS);
		const fileWatcherPromise = promisifyWatcher(fileWatcher);

		this.watchers.push(fileWatcher);

		return fileWatcherPromise
			.then(() => {
				fileWatcher
					.on('error', error => this.eventBus.emit('error', error))
					.on('add', filename => {
						const storeDescriptor = this.storeFinder.addStoreByFilename(filename);

						this.emit('addStore', storeDescriptor);

						this.storeLoader.reloadStore(storeDescriptor);
					})
					.on('change', filename => {
						const storeDescriptor = this.storeFinder.addStoreByFilename(filename);

						this.emit('changeStore', storeDescriptor);

						this.storeLoader.reloadStore(storeDescriptor);

						this.emit('reloadStore', storeDescriptor);
					})
					.on('unlink', filename => {
						const storeDescriptor = this.storeFinder.deleteStoreByFilename(filename);

						this.emit('unlinkStore', storeDescriptor);

						this.storeLoader.reloadStore(storeDescriptor);
					});

				return fileWatcher;
			});
	}

	/**
	 * Watches the components for changing.
	 *
	 * @return {Promise} Promise of ready watchers.
	 */
	watchComponents() {
		return Promise.all([
			this.watchComponentJson(),
			this.watchComponentLogicAndTemplate()
		])
	}

	watchComponentLogicAndTemplate() {
		// watch logic and templates
		const fileWatcher = chokidar.watch(this.componentFinder.getDirsOfFoundComponents(), CHOKIDAR_OPTIONS);
		const fileWatcherReadyPromise = promisifyWatcher(fileWatcher);

		this.componentLogicWatcher = fileWatcher;
		this.watchers.push(fileWatcher);

		return fileWatcherReadyPromise.then(() => {
			fileWatcher
				.on('error', error => this.eventBus.emit('error', error))
				// component's directory is changed
				.on('change', filename => {
					const foundComponentsByDirs = this.componentFinder.getFoundComponentsByDirs();
					const componentDescriptor = recognizeComponent(filename, foundComponentsByDirs);

					if (!componentDescriptor || componentDescriptor.path === filename) {
						return;
					}

					const {
						path: componentPath,
						properties: {
							logic: logicFilename,
							template: templateName,
							errorTemplate: errorTemplateName
						}
					} = componentDescriptor;
					const changeArgs = {filename, component: componentDescriptor};

					// logic file is changed
					const relativeLogic = getRelativeForComponent(componentPath, logicFilename);
					if (filename === relativeLogic) {
						this.emit('changeLogic', componentDescriptor);
						this.emit('changeComponent', changeArgs);

						return this.componentLoader.reloadComponentByDetails(componentDescriptor);
					}

					// template files are changed
					const relativeTemplate = getRelativeForComponent(componentPath, templateName);
					const relativeErrorTemplate =
						typeof (errorTemplateName) === 'string' ? getRelativeForComponent(componentPath, errorTemplateName) : null;

					if (filename === relativeTemplate || filename === relativeErrorTemplate) {
						this.emit('changeTemplates', componentDescriptor);
						this.emit('changeComponent', changeArgs);

						return this.componentLoader.reloadComponentByDetails(componentDescriptor);
					}

					this.emit('changeComponent', changeArgs);

					return this.componentLoader.reloadComponentByDetails(componentDescriptor);
				})
				.on('unlink', filename => {
					const foundComponentsByDirs = this.componentFinder.getFoundComponentsByDirs();
					const componentDescriptor = recognizeComponent(filename, foundComponentsByDirs);

					if (!componentDescriptor || componentDescriptor.path === filename) {
						return;
					}

					this.emit('changeComponent', {filename, component: componentDescriptor});
					return this.componentLoader.reloadComponentByDetails(componentDescriptor);
				})
				.on('add', filename => {
					const foundComponentsByDirs = this.componentFinder.getFoundComponentsByDirs();
					const componentDescriptor = recognizeComponent(filename, foundComponentsByDirs);

					if (!componentDescriptor || componentDescriptor.path === filename) {
						return;
					}

					this.emit('changeComponent', {filename, component: componentDescriptor});
					return this.componentLoader.reloadComponentByDetails(componentDescriptor);
				});
		})
	}

	watchComponentJson() {
		// watch cat-component.json files
		const componentJsonWatcher = chokidar.watch(this.componentFinder.getComponentsGlobExpression(), CHOKIDAR_OPTIONS);
		const componentJsonReadyPromise = promisifyWatcher(componentJsonWatcher);

		this.watchers.push(componentJsonWatcher);

		return componentJsonReadyPromise.then(() => {
			componentJsonWatcher
				.on('error', error => this.eventBus.emit('error', error))
				.on('add', filename => {
					const componentDescriptor = this.addComponent(filename);

					this.emit('addComponent', componentDescriptor);

					return this.componentLoader.reloadComponentByDetails(componentDescriptor);
				})
				.on('change', filename => {
					const oldComponentDescriptor = this.removeComponent(filename);

					if (oldComponentDescriptor) {
						this.emit('unlinkComponent', oldComponentDescriptor);
						this.componentLoader.unloadComponentByStoreDetails(oldComponentDescriptor);

						const newComponentDescriptor = this.addComponent(oldComponentDescriptor.path);
						this.emit('addComponent', newComponentDescriptor);

						return this.componentLoader.reloadComponentByDetails(newComponentDescriptor);
					}
				})
				.on('unlink', filename => {
					const componentDescriptor = this.removeComponent(filename);

					if (componentDescriptor) {
						this.emit('unlinkComponent', componentDescriptor);

						return this.componentLoader.unloadComponentByDetails(componentDescriptor);
					}
				});
		})
	}

	addComponent(filename) {
		const componentDescriptor = this.componentFinder._createComponentDescriptor(filename);

		this.componentFinder._addComponent(componentDescriptor);

		if (this.componentLogicWatcher) {
			this.componentLogicWatcher.add(path.dirname(componentDescriptor.path));
		}

		return componentDescriptor;
	}

	removeComponent(filename) {
		const foundComponentsByDirs = this.componentFinder.getFoundComponentsByDirs();
		const componentDescriptor = recognizeComponent(filename, foundComponentsByDirs);

		if (componentDescriptor) {
			this.componentFinder._removeComponent(componentDescriptor);

			if (this.componentLogicWatcher) {
				this.componentLogicWatcher.unwatch(path.dirname(componentDescriptor.path));
			}

			return componentDescriptor;
		}
	}
}


function promisifyWatcher(watcher) {
	return new Promise((resolve, reject) =>
		watcher
			.once('ready', () => resolve())
			.once('error', error => reject(error))
	);
}

/**
 * Gets a component's inner path which is relative to CWD.
 * @param {string} componentPath The path to the component.
 * @param {string} innerPath The path inside the component.
 * @returns {string} The path which is relative to CWD.
 */
function getRelativeForComponent(componentPath, innerPath) {
	return path.relative(
		process.cwd(), path.normalize(
			path.join(path.dirname(componentPath), innerPath)
		)
	);
}

/**
 * Recognizes a component by a path to its internal file.
 *
 * @param {string} filename The filename of the internal file of the component.
 * @param {Object} foundComponentsByDirs Hash with components by dirs
 * @returns {{name: string, path: string, properties: Object}|null} The found component's descriptor.
 */
function recognizeComponent(filename, foundComponentsByDirs = {}) {
	let current = filename;
	let component = null;

	while (current !== '.') {
		if (current in foundComponentsByDirs) {
			component = foundComponentsByDirs[current];
			break;
		}
		current = path.dirname(current);
	}
	return component;
}

module.exports = Watcher;
