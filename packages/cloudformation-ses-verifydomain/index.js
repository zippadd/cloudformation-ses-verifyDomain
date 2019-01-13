const cfnCR = require("cfn-custom-resource");
const AWS = require("aws-sdk");

const UPSERT = "UPSERT";
const DELETE = "DELETE";

const NO_MATCH_NAME_ERROR = "Unable to find any matching zones at all given provided domain name";
const NO_EXACT_MATCH_NAME_ERROR = "Unable to find an exact matching zone given provided domain name";

/**
 * Returns a Zone Id for a domain looked up by name
 * @param {string} domainName Name of the domain to look up (e.g. domain.com)
 * @return {string}           Zone Id if domain is found or an error thrown if not
 */
const getZoneIdByName = async (domainName) => {
  const route53 = new AWS.Route53({apiVersion: "2013-04-01"});

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
 * Verifies the domain with SES for both verification and DKIM
 * @param {string} hostedZoneIdOrName   Route53 hosted id or name of the domain to verify
 * @param {string} action         Action to take for Route53. Must be either: "CREATE", "UPSERT", or "DELETE"
 * @return {Promise}        Returns a promise that provides the result of the record addition, which is the domain name
 *                          and changeId or rejects on an error
 */
const verifyDomain = async (hostedZoneIdOrName, action) => {
  const ses = new AWS.SES({apiVersion: "2010-12-01"});
  const route53 = new AWS.Route53({apiVersion: "2013-04-01"});

  const dotSplitLen = hostedZoneIdOrName.split(".").length; // Used to signal if a name or id. Id's don't have dots and will be length 1

  const hostedZoneId = dotSplitLen === 1 ? hostedZoneIdOrName : await getZoneIdByName(hostedZoneIdOrName);
  const domainName = dotSplitLen === 1 ?
    (await route53.getHostedZone({Id: hostedZoneIdOrName}).promise()).HostedZone.Name :
    hostedZoneIdOrName;

  const sesParams = {Domain: domainName};

  const domainIDPromise = ses.verifyDomainIdentity(sesParams).promise();
  const domainDkimPromise = ses.verifyDomainDkim(sesParams).promise();
  const [{VerificationToken}, {DkimTokens}] = await Promise.all([domainIDPromise, domainDkimPromise]);

  const SESVerifyHost = "_amazonses";
  const dkimHost = "_domainkey";
  const SESVerifyDkim = "dkim.amazonses.com";

  if (action === DELETE) {
    const sesDelParams = {Identity: domainName};
    await ses.deleteIdentity(sesDelParams).promise();
  }

  const r53Changes = [];

  r53Changes.push({
    Action: action,
    ResourceRecordSet: {
      Name: `${SESVerifyHost}.${domainName}`,
      ResourceRecords: [
        {Value: `"${VerificationToken}"`}
      ],
      TTL: 60,
      Type: "TXT",
      MultiValueAnswer: true,
      SetIdentifier: `cfn-ses-verifyDomain-${process.env.AWS_REGION}`
    }
  });

  for (const dkimToken of DkimTokens) {
    r53Changes.push({
      Action: action,
      ResourceRecordSet: {
        Name: `${dkimToken}.${dkimHost}.${domainName}`,
        ResourceRecords: [
          {Value: `${dkimToken}.${SESVerifyDkim}`}
        ],
        TTL: 60,
        Type: "CNAME"
      }
    });
  }

  const r53Params = {
    ChangeBatch: {
      Changes: r53Changes,
      Comment: "Records to verify domain ownership and DKIM for SES send/receive"
    },
    HostedZoneId: hostedZoneId
  };

  const {ChangeInfo: {Id}} = await route53.changeResourceRecordSets(r53Params).promise();

  return {domainName, changeId: Id};
};

/**
 * Lambda handler
 * @param  {Object}   event    Lambda event
 * @return {Promise}           Async Promise for handling the event
 */
const handler = async (event, /* context */) => {
  console.log(event);

  const {RequestType, ResourceProperties, OldResourceProperties, PhysicalResourceId} = event;

  const {HostedZoneId, HostedZoneName} = ResourceProperties;
  const zoneIdOrName = HostedZoneId ? HostedZoneId : HostedZoneName;

  switch (RequestType) {
  case cfnCR.CREATE: {
    try {
      const {domainName, changeId} = await verifyDomain(zoneIdOrName, UPSERT);
      return cfnCR.sendSuccess(domainName, {changeId}, event);
    } catch (err) {
      return cfnCR.sendFailure(err, event);
    }
  }
  case cfnCR.UPDATE: {
    try {
      const {HostedZoneId: OldHostedZoneId, HostedZoneName: OldHostedZoneName} = OldResourceProperties;
      const oldZoneIdOrName = OldHostedZoneId ? OldHostedZoneId : OldHostedZoneName;
      const {domainName: oldDomainName, changeId: oldChangeId} = await verifyDomain(oldZoneIdOrName, DELETE);
      const {domainName, changeId} = await verifyDomain(zoneIdOrName, UPSERT);
      return cfnCR.sendSuccess(domainName, {newChangeId: changeId, oldChangeId, oldDomainName}, event);
    } catch (err) {
      return cfnCR.sendFailure(err, event);
    }
  }
  case cfnCR.DELETE: {
    try {
      const {changeId} = await verifyDomain(zoneIdOrName, DELETE);
      return cfnCR.sendSuccess(PhysicalResourceId, {changeId}, event);
    } catch (err) {
      /* We don't specify an alternate resource id on a sendFailure,
         and by default it is set to this constant when a physical
         resource id is not set.
         As such, if the CREATE method failed, it will be set to this.
         To prevent an unrecoverable state, we want to allow this
         to post success. */
      if (PhysicalResourceId === cfnCR.DEFAULT_PHYSICAL_RESOURCE_ID) {
        return cfnCR.sendSuccess(PhysicalResourceId, null, event);
      }

      return cfnCR.sendFailure(err, event);
    }
  }
  default:
    return cfnCR.sendFailure(new Error("Invalid request type or event"), event);
  }
};

module.exports = {handler, verifyDomain, getZoneIdByName, UPSERT, DELETE};
