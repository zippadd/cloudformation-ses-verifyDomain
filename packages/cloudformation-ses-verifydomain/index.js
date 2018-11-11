const cfnCR = require("cfn-custom-resource");
const AWS = require("aws-sdk");

/**
 * Verifies the domain with SES for both verification and DKIM
 * @param {*} hostedZoneId  Route53 hosted id of the domain to verify
 * @param {*} action        Action to take for Route53. Must be either: "CREATE", "UPSERT", or "DELETE"
 * @return {Promise}        Returns a promise that provides the result of the record addition or rejects on an error
 */
const verifyDomain = async (hostedZoneId, action) => {
  const ses = new AWS.SES({apiVersion: "2010-12-01"});
  const route53 = new AWS.Route53({apiVersion: "2013-04-01"});
  const domainLookupParams = {Id: hostedZoneId};

  const {HostedZone: {Name: domainName}} = await route53.getHostedZone(domainLookupParams).promise();

  const sesParams = {Domain: domainName};

  const domainIDPromise = ses.verifyDomainIdentity(sesParams).promise();
  const domainDkimPromise = ses.verifyDomainDkim(sesParams).promise();
  const [{VerificationToken}, {DkimTokens}] = await Promise.all([domainIDPromise, domainDkimPromise]);

  const SESVerifyHost = "_amazonses";
  const dkimHost = "_domainkey";
  const SESVerifyDkim = "dkim.amazonses.com";

  const r53Changes = [];

  r53Changes.push({
    Action: action,
    ResourceRecordSet: {
      Name: `${SESVerifyHost}.${domainName}`,
      ResourceRecords: [
        {Value: VerificationToken}
      ],
      TTL: 60,
      Type: "TXT"
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

  const {RequestType, ResourceProperties, OldResourceProperties} = event;

  const {HostedZoneId} = ResourceProperties;

  switch (RequestType) {
  case cfnCR.CREATE: {
    try {
      const {domainName, changeId} = await verifyDomain(HostedZoneId, "UPSERT");
      return cfnCR.sendSuccess(domainName, {changeId}, event);
    } catch (err) {
      return cfnCR.sendFailure(err, event);
    }
  }
  case cfnCR.UPDATE: {
    try {
      const {HostedZoneId: OldHostedZoneId} = OldResourceProperties;
      const {domainName: oldDomainName, changeId: oldChangeId} = await verifyDomain(OldHostedZoneId, "DELETE");
      const {domainName, changeId} = await verifyDomain(HostedZoneId, "UPSERT");
      return cfnCR.sendSuccess(domainName, {newChangeId: changeId, oldChangeId, oldDomainName}, event);
    } catch (err) {
      return cfnCR.sendFailure(err, event);
    }
  }
  case cfnCR.DELETE: {
    try {
      const {domainName, changeId} = await verifyDomain(HostedZoneId, "DELETE");
      return cfnCR.sendSuccess(domainName, {changeId}, event);
    } catch (err) {
      return cfnCR.sendFailure(err, event);
    }
  }
  default:
    return cfnCR.sendFailure(new Error("Invalid request type or event"), event);
  }
};

module.exports = {handler, verifyDomain};
