'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const globby = require('globby');
const BbPromise = require('bluebird');
const _ = require('lodash');
const normalizeFiles = require('../../lib/normalizeFiles');
const ServerlessError = require('../../../../serverless-error');

module.exports = {
  async checkForChanges() {
    this.serverless.service.provider.shouldNotDeploy = false;

    if (this.options.force) {
      return this.checkLogGroupSubscriptionFilterResourceLimitExceeded();
    }

    return BbPromise.bind(this)
      .then(this.getMostRecentObjects)
      .then((objs) => {
        return BbPromise.all([
          this.getObjectMetadata(objs),
          this.getFunctionsEarliestLastModifiedDate(),
        ]);
      })
      .then(([objMetadata, lastModifiedDate]) =>
        this.checkIfDeploymentIsNecessary(objMetadata, lastModifiedDate)
      )
      .then(() => {
        if (this.serverless.service.provider.shouldNotDeploy) {
          return BbPromise.resolve();
        }

        // perform the subscription filter checking only if a deployment is required
        return this.checkLogGroupSubscriptionFilterResourceLimitExceeded();
      });
  },

  async getMostRecentObjects() {
    const service = this.serverless.service.service;

    const params = {
      Bucket: this.bucketName,
      Prefix: `${this.provider.getDeploymentPrefix()}/${service}/${this.provider.getStage()}`,
    };

    return this.provider
      .request('S3', 'listObjectsV2', params)
      .catch((reason) => {
        if (!reason.message.includes('The specified bucket does not exist')) {
          return BbPromise.reject(reason);
        }
        const stackName = this.provider.naming.getStackName();
        return BbPromise.reject(
          new ServerlessError(
            [
              `The serverless deployment bucket "${params.Bucket}" does not exist.`,
              `Create it manually if you want to reuse the CloudFormation stack "${stackName}",`,
              'or delete the stack if it is no longer required.',
            ].join(' ')
          )
        );
      })
      .then((result) => {
        if (result && result.Contents && result.Contents.length) {
          const objects = result.Contents;

          const ordered = _.orderBy(objects, ['Key'], ['desc']);

          const firstKey = ordered[0].Key;
          const directory = firstKey.substring(0, firstKey.lastIndexOf('/'));

          const mostRecentObjects = ordered.filter((obj) => {
            const objKey = obj.Key;
            const objDirectory = objKey.substring(0, objKey.lastIndexOf('/'));

            return directory === objDirectory;
          });

          return BbPromise.resolve(mostRecentObjects);
        }

        return BbPromise.resolve([]);
      });
  },

  // Gives the least recent last modify date across all the functions in the service.
  async getFunctionsEarliestLastModifiedDate() {
    let couldNotAccessFunction = false;
    const getFunctionResults = this.serverless.service.getAllFunctions().map((funName) => {
      const functionObj = this.serverless.service.getFunction(funName);
      return this.provider
        .request('Lambda', 'getFunction', {
          FunctionName: functionObj.name,
        })
        .then((res) => new Date(res.Configuration.LastModified))
        .catch((err) => {
          if (err.providerError && err.providerError.statusCode === 403) {
            couldNotAccessFunction = true;
          }
          return new Date(0);
        }); // Function is missing, needs to be deployed
    });

    return BbPromise.all(getFunctionResults).then((results) => {
      if (couldNotAccessFunction) {
        this.serverless.cli.log(
          [
            'WARNING: Not authorized to perform: lambda:GetFunction for at least one of the lambda functions.',
            ' Deployment will not be skipped even if service files did not change. ',
          ].join(''),
          'Serverless',
          { color: 'orange' }
        );
      }

      return results.reduce((currentMin, date) => {
        if (!currentMin || date < currentMin) return date;
        return currentMin;
      }, null);
    });
  },

  async getObjectMetadata(objects) {
    if (objects && objects.length) {
      const headObjectObjects = objects.map((obj) =>
        this.provider.request('S3', 'headObject', {
          Bucket: this.bucketName,
          Key: obj.Key,
        })
      );

      return BbPromise.all(headObjectObjects).then((result) => result);
    }

    return BbPromise.resolve([]);
  },

  async checkIfDeploymentIsNecessary(objects, funcLastModifiedDate) {
    if (objects && objects.length) {
      const remoteHashes = objects.map((object) => object.Metadata.filesha256 || '');

      const serverlessDirPath = path.join(this.serverless.config.servicePath, '.serverless');

      // create a hash of the CloudFormation body
      const compiledCfTemplate = this.serverless.service.provider.compiledCloudFormationTemplate;
      const normCfTemplate = normalizeFiles.normalizeCloudFormationTemplate(compiledCfTemplate);
      const localCfHash = crypto
        .createHash('sha256')
        .update(JSON.stringify(normCfTemplate))
        .digest('base64');

      // create hashes for all the zip files
      const zipFiles = globby.sync(['**.zip'], { cwd: serverlessDirPath, dot: true, silent: true });
      if (this.serverless.service.package.artifact) {
        zipFiles.push(
          path.resolve(this.serverless.config.servicePath, this.serverless.service.package.artifact)
        );
      }
      this.serverless.cli.log('IS DEPLOYMENT NECESSARY', 'Serverless', { color: "orange"});
      this.serverless.cli.log(`zipFiles: ${zipFiles}`, 'Serverless', { color: "orange"});

      // resolve paths and ensure we only hash each unique file once.
      const zipFilePaths = Array.from(
        new Set(zipFiles.map((zipFile) => path.resolve(serverlessDirPath, zipFile)))
      );
      this.serverless.cli.log(`zipFilePaths: ${zipFilePaths}`, 'Serverless', { color: "orange"});

      const readFile = BbPromise.promisify(fs.readFile);
      const zipFileHashesPromises = zipFilePaths.map((zipFilePath) =>
        readFile(zipFilePath).then((zipFile) =>
          crypto.createHash('sha256').update(zipFile).digest('base64')
        )
      );

      return BbPromise.all(zipFileHashesPromises).then((zipFileHashes) => {
        const localHashes = zipFileHashes;
        this.serverless.cli.log(`zipFileHashes: ${zipFileHashes}`, 'Serverless', { color: "orange"});
        localHashes.push(localCfHash);

        // If any objects were changed after the last time the function was updated
        // there could have been a failed deploy.
        const changedAfterDeploy = objects.some((object) => {
          return object.LastModified && object.LastModified > funcLastModifiedDate;
        });

        const areHashesEqual = _.isEqual(remoteHashes.sort(), localHashes.sort());
        if (!changedAfterDeploy && areHashesEqual) {
          this.serverless.service.provider.shouldNotDeploy = true;

          const message = ['Service files not changed. Skipping deployment...'].join('');
          this.serverless.cli.log(message, 'Serverless', { color: 'orange' });
        } else {
          this.serverless.cli.log('NOT SKIPPING DEPLOYMENT', 'Serverless', { color: "orange"});
          if (changedAfterDeploy) {
            this.serverless.cli.log('REASON: Objects have been changed AFTER functions last modifications (probably a failed deploy)', 'Serverless', { color: "orange"});
          }
          if (!areHashesEqual) {
            this.serverless.cli.log('REASON: Hashes are not equal', 'Serverless', { color: "orange" });
            this.serverless.cli.log(`Remote hashes: ${remoteHashes.toString()}`, 'Serverless', { color: "orange" })
            this.serverless.cli.log(`Local hashes: ${localHashes.toString()}`, 'Serverless', { color: "orange" })
          }
        }
      });
    }

    return BbPromise.resolve();
  },

  /**
   * @description Cloudwatch imposes a hard limit of 1 subscription filter per log group.
   * If we change a cloudwatchLog event entry to add a subscription filter to a log group
   * that already had one before, it will throw an error because CloudFormation firstly
   * tries to create and replace the new subscription filter (therefore hitting the limit)
   * before deleting the old one. This precompile process aims to delete existent
   * subscription filters of functions that a new filter was provided, by checking the
   * current ARN with the new one that will be generated.
   * See: https://git.io/fpKCM
   */
  async checkLogGroupSubscriptionFilterResourceLimitExceeded() {
    const region = this.provider.getRegion();

    return this.provider.getAccountInfo().then((account) =>
      Promise.all(
        this.serverless.service.getAllFunctions().map((functionName) => {
          const functionObj = this.serverless.service.getFunction(functionName);

          if (!functionObj.events) {
            return BbPromise.resolve();
          }

          let logSubscriptionSerialNumber = 0;
          const promises = functionObj.events.map((event) => {
            if (!event.cloudwatchLog) {
              return BbPromise.resolve();
            }

            let logGroupName;

            /*
              it isn't necessary to run sanity checks here as they already happened during the
              compile step
            */
            if (typeof event.cloudwatchLog === 'object') {
              logGroupName = event.cloudwatchLog.logGroup.replace(/\r?\n/g, '');
            } else {
              logGroupName = event.cloudwatchLog.replace(/\r?\n/g, '');
            }

            const accountId = account.accountId;
            const partition = account.partition;

            logSubscriptionSerialNumber++;

            /*
              return a new promise that will check the resource limit exceeded and will fix it if
              the option is enabled
            */
            return this.fixLogGroupSubscriptionFilters({
              accountId,
              logGroupName,
              functionName,
              functionObj,
              region,
              partition,
              logSubscriptionSerialNumber,
            });
          });

          return Promise.all(promises);
        })
      )
    );
  },

  async fixLogGroupSubscriptionFilters(params) {
    const accountId = params.accountId;
    const logGroupName = params.logGroupName;
    const functionName = params.functionName;
    const functionObj = params.functionObj;
    const region = params.region;
    const partition = params.partition;
    const logSubscriptionSerialNumber = params.logSubscriptionSerialNumber;

    return (
      this.provider
        .request(
          'CloudWatchLogs',
          'describeSubscriptionFilters',
          { logGroupName },
          { useCache: true }
        )
        .then((response) => {
          const subscriptionFilter = response.subscriptionFilters[0];

          // log group doesn't have any subscription filters currently
          if (!subscriptionFilter) {
            return false;
          }

          const filterName = subscriptionFilter.filterName;

          const oldDestinationArn = subscriptionFilter.destinationArn;
          const newDestinationArn = `arn:${partition}:lambda:${region}:${accountId}:function:${functionObj.name}`;
          const oldLogicalId = this.getLogicalIdFromFilterName(filterName);
          const newLogicalId = this.provider.naming.getCloudWatchLogLogicalId(
            functionName,
            logSubscriptionSerialNumber
          );

          // everything is fine, just return
          if (oldDestinationArn === newDestinationArn && oldLogicalId === newLogicalId) {
            return false;
          }

          /*
            If the destinations functions' ARNs doesn't match, we need to delete the current
            subscription filter to prevent the resource limit exceeded error to happen
          */
          return this.provider.request('CloudWatchLogs', 'deleteSubscriptionFilter', {
            logGroupName,
            filterName,
          });
        })
        /*
        it will throw when trying to get subscription filters of a log group that was just added
        to the serverless.yml (therefore not created in AWS yet), we can safely ignore this error
      */
        .catch(() => undefined)
    );
  },

  getLogicalIdFromFilterName(filterName) {
    // Filter name format:
    // {stack name}-{logical id}-{random alphanumeric characters}
    // Note that the stack name can include hyphens
    const split = filterName.split('-');
    return split[split.length - 2];
  },
};
