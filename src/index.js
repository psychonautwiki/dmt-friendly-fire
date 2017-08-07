'use strict';

const Docker = require('dockerode');
const Promise = require('bluebird');

const thread_sleep = timeout =>
    new Promise((res, _) =>
        setTimeout(res, timeout)
    );

/*
    U
        1 obtain list of servers
        2 if not known
            3 if started at + rolloverInterval > now
                4 let next rollover time = now + ((started at + rolloverInterval) - now)
            5 else
                6 let next rollover time = now + rolloverInterval

    W
        1 if next rollover time < now
            2 stop
            3 start
            4 let next rollover time = now + (rolloverInterval * 0.5) + (rolloverInterval * Math.random() * 0.5)
*/

class FriendlyFire {
    constructor() {
        this._config = {
            workerMutex: false,
            rolloverInterval: 30 * 60 * 1000,
            initialDebounce: 5 * 60 * 1000,
            services: [],
            serviceMap: new Map(),
            serviceIntervals: {}
        };

        this._rolloverStateMachine = new Map();

        const {FF_DOCKER_HOST, FF_DOCKER_PORT} = process.env;

        let dockerConfig;

        if (FF_DOCKER_HOST && FF_DOCKER_PORT) {
            dockerConfig = {
                host: FF_DOCKER_HOST,
                port: FF_DOCKER_PORT
            };
        }

        this._docker = new Docker(dockerConfig);

        this._getServiceEnv();

        setInterval((() => this._updateMemory()), 5000);
        setInterval((() => this._worker()), 2000);
    }

    _getServiceEnv () {
        const services = process.env['FF_SERVICES'];

        if (!services) throw new Error('Invalid services given');

        this._config.services = services.toLowerCase().split(',');
    }

    * _sortContainersByAge (containerIds) {
        const containerInfo = yield Promise.all(
            Array.from(containerIds).map(containerId =>
                this._docker.getContainer(containerId).inspect()
            )
        );

        const now = new Date();

        return containerInfo.sort((a, b) => {
            const started = new Date(a.State.StartedAt);

            return started > now ? -1 : started < now ? 1 : 0;
        }).map(container => container.Id);
    }

    * _updateServiceMapping (rootService, containerIds) {
        const sortedContainerIds = yield* this._sortContainersByAge(containerIds);

        console.log('Reloading service map..\n');

        sortedContainerIds.forEach(containerId =>
            console.log('✘ %s => %s', rootService, containerId)
        );

        console.log('');

        this._config.serviceMap.set(rootService, sortedContainerIds);

        this._config.serviceIntervals[rootService] = new Date(Date.now() + this._config.initialDebounce);
    }

    _containerIdDisplay (containerId) {
        return containerId.slice(0, 9);
    }
}

FriendlyFire.prototype._updateMemory = Promise.coroutine(function* () {
    while(true) {
        /* if worker is in process, wait until it is done */
        while(this._workerMutex) {
            yield thread_sleep(1000);
        }

        const containers = yield this._docker.listContainers();

        const qualifiedServices = new Set(this._config.services);
        const serviceMap = new Map();

        /* populate containers */
        containers.forEach(container => {
            const rawRootService = container.Labels['com.docker.compose.service'];

            if (!rawRootService) {
                return;
            }

            const rootService = rawRootService.toLowerCase();

            if (qualifiedServices.has(rootService)) {
                const services = serviceMap.get(rootService) || [];

                !services.includes(container.Id) && services.push(container.Id);

                serviceMap.set(rootService, services);
            }
        });

        /* determine if containers changed */
        if (!this._config.serviceMap.size) {
            this._config.serviceMap = serviceMap;

            for (const service of this._config.serviceMap) {
                const [rootService, containerIds] = service;

                yield* this._updateServiceMapping(rootService, containerIds);
            }

            continue;
        }

        for (const service of this._config.serviceMap) {
            const [rootService, containerIds] = service;

            const newContainerIds = serviceMap.get(rootService);

            if (newContainerIds) {
                const idsDiffer = newContainerIds.some(containerId =>
                    !containerIds.includes(containerId)
                );

                if (idsDiffer) {
                    yield* this._updateServiceMapping(rootService, containerIds);
                }
            }
        }

        yield thread_sleep(1000);
    }
});

FriendlyFire.prototype._worker = Promise.coroutine(function* () {
    if (this._workerMutex) return;

    this._workerMutex = true;

    for (const service of this._config.serviceMap) {
        const [rootService, containerIds] = service;

        if (this._config.serviceIntervals[rootService] < new Date()) {
            this._config.serviceIntervals[rootService] = new Date(Date.now() + this._config.rolloverInterval);

            const containerId = containerIds.shift();
                                containerIds.push(containerId);

            const containerDisplayId = this._containerIdDisplay(containerId);

            const container = this._docker.getContainer(containerId);

            console.log('✔ Stopping %s of service %s...', containerDisplayId, rootService);

            yield container.stop();

            console.log('✔ Starting %s of service %s...', containerDisplayId, rootService);

            yield container.start();

            console.log('');

            this._config.serviceMap.set(rootService, containerIds);
        }
    }

    this._workerMutex = false;
});

console.log('~~~~~~ DMT FriendlyFire ~~~~~~\n')

new FriendlyFire();
