/* Requires */
const cfnCR = require("cfn-custom-resource");
const AWS = require("aws-sdk");
const interval = require("interval-promise");

/* Constants */
const UPSERT = "UPSERT";
const DELETE = "DELETE";
const AMAZON_ISSUED_CERT_TYPE = "AMAZON_ISSUED";
const ERR_INVALID_CERTIFICATE = "Invalid Certificate. This custom resource is only for Amazon issued certificates.";
const PENDING_VALIDATION = "PENDING_VALIDATION";
const ACM_API_VERSION = "2015-12-08";
const R53_API_VERSION = "2013-04-01";
const NO_MATCH_NAME_ERROR = "Unable to find any matching zones at all given provided domain name";
const NO_EXACT_MATCH_NAME_ERROR = "Unable to find an exact matching zone given provided domain name";

/**
 * Returns a Zone Id for a domain looked up by name
 * @param {string} domainName Name of the domain to look up (e.g. domain.com)
 * @return {string}           Zone Id if domain is found or empty string if not
 */
const getZoneIdByName = async (domainName) => {
  const route53 = new AWS.Route53({apiVersion: R53_API_VERSION});

  const params = {DNSName: domainName};

  const {HostedZones} = await route53.listHostedZonesByName(params).promise();

  if (!HostedZones || HostedZones.length < 1) {
    throw new Error(NO_MATCH_NAME_ERROR);
  }

  /*  Due to lexicographic ordering, matching domain should be first item
      See https://docs.aws.amazon.com/AWSJavaScriptSDK/latest/AWS/Route53.html#listHostedZonesByName-property for details */
  const [{Id, Name}] = HostedZones;

  /*  It's possible that the domain name given is not an exact match, so check.
      E.g. a query for ap.domain.com that only has zap.domain.com and sap.domain.com
      would return sap.domain.com, which is not an exact match.
      However, if it also has ap.domain.com it should correctly return ap.domain.com

      Name has a trailing period, so check if a match with and without it to allow
      lookup with a trailing period present
      */
  if (!(Name.slice(0, -1) === domainName || Name === domainName)) {
    throw new Error(NO_EXACT_MATCH_NAME_ERROR);
  }

  return Id.replace("/hostedzone/", "");
};

/**
 * Gets the proper zone id for an FQDN
 * @param {string} fqdn       Fully qualified domain name
 * @returns {Promise.string}  Promise to return zone id for the FQDN
 */
const getZoneIdByFQDN = async (fqdn) => {
  const route53 = new AWS.Route53({apiVersion: R53_API_VERSION});
  const normalizedFQDN = fqdn.endsWith(".") ? fqdn.slice(0, -1) : fqdn;
  const [tld, ...rest] = normalizedFQDN.split(".").reverse();
  let domainName = tld;
  let zoneId;

  for (let domainNameIndex = 0; domainNameIndex < rest.length; domainNameIndex++) {
    domainName = `${rest[domainNameIndex]}.${domainName}`;
    zoneId = await getZoneIdByName(domainName); // eslint-disable-line no-await-in-loop

    const r53Params = {
      HostedZoneId: zoneId,
      RecordName: normalizedFQDN,
      RecordType: "NS"
    };
    const {RecordData} = await route53.testDNSAnswer(r53Params).promise(); // eslint-disable-line no-await-in-loop

    if (!RecordData.length) {
      return zoneId;
    }
  }

  throw new Error("Unable to determine zone id");
};

/**
 * Temp
 * @param {string} certificateArn   ARN of the certificate
 * @param {string} action           Action to take (CREATE, UPSERT, DELETE)
 * @return {Promise}                Promise for publishing the cert's validation DNS
 */
const publishCertValidationDNS = async (certificateArn, action) => {
  const acm = new AWS.ACM({apiVersion: ACM_API_VERSION});
  const r53 = new AWS.Route53({apiVersion: R53_API_VERSION});

  const acmParams = {CertificateArn: certificateArn};
  const {Certificate: {Type: certType, DomainValidationOptions}} = await acm.describeCertificate(acmParams).promise();

  if (certType !== AMAZON_ISSUED_CERT_TYPE) {
    throw new Error(ERR_INVALID_CERTIFICATE);
  }

  const Changes = {};
  const resourceRecords = [];
  const zoneIdLookupPromises = [];

  for (const validationOption of DomainValidationOptions) {
    const {DomainName, ResourceRecord, ValidationStatus} = validationOption;

    if (ValidationStatus !== PENDING_VALIDATION) {
      continue; // eslint-disable-line no-continue
    }

    resourceRecords.push(ResourceRecord);
    zoneIdLookupPromises.push(getZoneIdByFQDN(DomainName));
  }

  const zoneIds = await Promise.all(zoneIdLookupPromises);

  for (let zoneIdIndex = 0; zoneIdIndex < zoneIds.length; zoneIdIndex++) {
    const zoneId = zoneIds[zoneIdIndex];
    const {Name, Type, Value} = resourceRecords[zoneIdIndex];

    if (!Changes[zoneId]) {
      Changes[zoneId] = [];
    }

    Changes[zoneId].push({
      Action: action,
      ResourceRecordSet: {
        Name,
        ResourceRecords: [
          {Value}
        ],
        TTL: 60,
        Type
      }
    });
  }

  const publishPromises = [];

  for (const zoneId of Object.keys(Changes)) {
    const changes = Changes[zoneId];
    const publishPromise = r53.changeResourceRecordSets({
      ChangeBatch: {
        Changes: changes,
        Comment: `Validation DNS for ${certificateArn}`
      },
      HostedZoneId: zoneId
    }).promise();
    publishPromises.push(publishPromise);
  }

  /* Allow deletes to silently fail to enable partial clean up e.g. for failed creates */
  const results = await Promise.all(action === DELETE ?
    publishPromises.map((promise) => {
      return promise.catch(() => {
        return null;
      });
    }) :
    publishPromises);
  return results.map((result) => {
    if (!result) {
      return null;
    }
    return result.ChangeInfo.Id;
  });
};

/**
 * Looks up the certificate and returns the ARN
 * @param {string} domainName   Domain name
 * @param {number} timeoutMs    Timeout in MS
 * @return {string}             Returns the certificate ARN
 */
const lookupCertificate = async (domainName, timeoutMs) => {
  const acm = new AWS.ACM({apiVersion: ACM_API_VERSION});
  const WAIT_BETWEEN_REQS_MS = 1000;
  let certificateArn;

  /**
   * Internal lookup function for interval
   * @api private
   * @param {Number} iterationNumber  Iteration number the interval is on
   * @param {Function} stop           Function to stop execution before iterations
   * @return {Promise.undefined}      Promise to do the lookup
   */
  const lookupCertificateInternal = async (iterationNumber, stop) => {
    let certs = [];
    let nextToken = "start";

    while (nextToken) {
      const params = {CertificateStatuses: [PENDING_VALIDATION]};

      if (nextToken && nextToken !== "start") {
        params.NextToken = nextToken;
      }

      const {NextToken, CertificateSummaryList} =
        await acm.listCertificates(params).promise(); // eslint-disable-line no-await-in-loop
      nextToken = NextToken;
      certs = certs.concat(CertificateSummaryList);
    }

    const certFindResult = certs.find((cert) => {
      return cert.DomainName === domainName;
    });

    if (certFindResult && certFindResult.CertificateArn) {
      certificateArn = certFindResult.CertificateArn;
      stop();
    }
  };

  const options = {stopOnError: true};

  if (timeoutMs) {
    options.iterations = Math.floor(timeoutMs / WAIT_BETWEEN_REQS_MS);
  }

  await interval(lookupCertificateInternal, WAIT_BETWEEN_REQS_MS, options);

  if (certificateArn) {
    return certificateArn;
  }

  throw new Error("Certificate lookup timed out");
};

/**
 * Temp
 * @param {*} event   Temp
 * @param {*} context Temp
 * @returns {*}       Temp
 */
const userHandlerLogic = async (event, context) => {
  const {ResourceProperties, OldResourceProperties, PhysicalResourceId} = event;
  const {CertificateFQDN} = ResourceProperties;
  const TIMEOUT_MARGIN_OF_SAFETY_MS = 3000;
  const lambdaTimeout = context.getRemainingTimeInMillis() - TIMEOUT_MARGIN_OF_SAFETY_MS;

  const certificateArn = await lookupCertificate(CertificateFQDN, lambdaTimeout);

  return {
    create: async () => {
      const changeIds = await publishCertValidationDNS(certificateArn, UPSERT);
      return {id: certificateArn, data: {changeIds}};
    },
    update: async () => {
      const {CertificateFQDN: OldCertificateFQDN} = OldResourceProperties;
      const oldCertificateArn = await lookupCertificate(OldCertificateFQDN, lambdaTimeout);
      const oldChangeIds = await publishCertValidationDNS(oldCertificateArn, DELETE);
      const changeIds = await publishCertValidationDNS(certificateArn, UPSERT);
      return {id: certificateArn, data: {changeIds, oldChangeIds, oldCertificateArn: PhysicalResourceId}};
    },
    delete: async () => {
      const changeIds = await publishCertValidationDNS(certificateArn, DELETE);
      return {id: PhysicalResourceId, data: {changeIds}};
    }
  };
};

/**
 * Temp
 * @param {*} event   Temp
 * @param {*} context Temp
 * @returns {*}       Temp
 */
const processCREvent = async (event, context) => {
  try {
    const method = {
      [cfnCR.CREATE]: "create",
      [cfnCR.UPDATE]: "update",
      [cfnCR.DELETE]: "delete"
    }[event.RequestType];
    const {id, data} = await (await userHandlerLogic(event, context))[method]();
    return cfnCR.sendSuccess(id, data, event);
  } catch (err) {
    /* We don't specify an alternate resource id on a sendFailure,
    and by default it is set to this constant when a physical
    resource id is not set.
    As such, if the CREATE method failed, it will be set to this.
    To prevent an unrecoverable state, we want to allow this
    to post success. */
    if (event && event.RequestType === cfnCR.DELETE && event.PhysicalResourceId === cfnCR.DEFAULT_PHYSICAL_RESOURCE_ID) {
      return cfnCR.sendSuccess(event.PhysicalResourceId, null, event);
    }
    return cfnCR.sendFailure(err, event);
  }
};

/**
 * Lambda handler
 * @param   {Object}  event     Lambda event
 * @param   {Object}  context   Lambda Context
 * @return  {Promise}           Async Promise for handling the event
 */
const handler = async (event, context) => {
  console.log(event);
  const result = await processCREvent(event, context);
  return result;
};

module.exports = {handler, lookupCertificate, publishCertValidationDNS, getZoneIdByFQDN, getZoneIdByName};
