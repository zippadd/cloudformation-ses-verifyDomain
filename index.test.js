jest.mock("cfn-custom-resource");

const {verifyDomain, handler} = require("./index");
const AWS = require("aws-sdk-mock");
const AWS_SDK = require("aws-sdk");
const crypto = require("crypto");
const {sendSuccess, sendFailure} = require("cfn-custom-resource");

sendSuccess.mockImplementation((physicalResourceId, data) => {
  return Promise.resolve({domainName: physicalResourceId, data});
});

sendFailure.mockImplementation((err) => {
  return Promise.reject(err);
});

AWS.setSDKInstance(AWS_SDK);

/**
 * Generates random id
 * @return {string} Random id
 */
const getRandId = () => {
  const LENGTH = 16;
  return crypto.randomBytes(LENGTH).toString("hex").toLowerCase();
};

/**
 * Deterministically calculates the change id based on the list of DNS records
 * Records must match the exact format and order to calcuate to the same change id
 * @param {Array} records DNS records in {Name, Value, Type} object format
 * @return {string} Change id as a string
 */
const calculateChangeId = (records) => {
  const recordsString = records.reduce((accumulator, currVal) => {
    return accumulator + JSON.stringify(currVal);
  }, "");
  const hash = crypto.createHash("sha256");
  hash.update(recordsString, "utf8");
  return hash.digest("hex");
};

/**
 * Gets a digest of a given string
 * @param {string} string     String to get digest of
 * @param {*} inputEncoding   Encoding of the input string. Default: utf8
 * @param {*} outputEncoding  Encoding of the output string. Default: hex
 * @param {*} algorithm       Algorithm for generating the digest. Default: sha256
 * @return {string}           Digest of the given string
 */
const getDigest = (string, inputEncoding = "utf8", outputEncoding = "hex", algorithm = "sha256") => {
  const hash = crypto.createHash(algorithm);
  hash.update(string, inputEncoding);
  return hash.digest(outputEncoding);
};

/**
 * Gets a reference change id deterministically to verify results
 * @param {string} domainName     Given domain name
 * @param {string} verificationToken   Generated verification token
 * @param {string} dkimTokens          Generated DKIM tokens
 * @return {string} Reference change id for verification
 */
const getRefChangeId = (domainName, verificationToken, dkimTokens) => {
  const verificationTokenRecords = [{Name: `_amazonses.${domainName}`, Value: verificationToken, Type: "TXT"}];
  const DkimTokenRecord1 = {Name: `${dkimTokens[0]}._domainkey.${domainName}`, Value: `${dkimTokens[0]}.dkim.amazonses.com`, Type: "CNAME"};
  const DkimTokenRecord2 = {Name: `${dkimTokens[1]}._domainkey.${domainName}`, Value: `${dkimTokens[1]}.dkim.amazonses.com`, Type: "CNAME"};
  const DkimTokenRecord3 = {Name: `${dkimTokens[2]}._domainkey.${domainName}`, Value: `${dkimTokens[2]}.dkim.amazonses.com`, Type: "CNAME"};
  const DkimTokenRecords = [DkimTokenRecord1, DkimTokenRecord2, DkimTokenRecord3];
  const totalRecords = verificationTokenRecords.concat(DkimTokenRecords);
  return calculateChangeId(totalRecords);
};

/* Set Up */
const hostedZoneId = getRandId();
const domainName = `${getDigest(hostedZoneId)}.com`;
const altHostedZoneId = getRandId();
const altDomainName = `${getDigest(altHostedZoneId)}.com`;
const VerificationToken = getRandId();
const DkimToken1 = getRandId();
const DkimToken2 = getRandId();
const DkimToken3 = getRandId();
const DkimTokens = [DkimToken1, DkimToken2, DkimToken3];
const refChangeId = getRefChangeId(domainName, VerificationToken, DkimTokens);
const altRefChangeId = getRefChangeId(altDomainName, VerificationToken, DkimTokens);

/* Set Up AWS Mocks */
AWS.mock("SES", "verifyDomainIdentity", (params, callback) => {
  return callback(null, {VerificationToken});
});
AWS.mock("SES", "verifyDomainDkim", (params, callback) => {
  return callback(null, {DkimTokens});
});
AWS.mock("Route53", "getHostedZone", (params, callback) => {
  const hostedZoneHash = crypto.createHash("sha256");
  hostedZoneHash.update(params.Id, "utf8");
  const calcDomainName = `${hostedZoneHash.digest("hex")}.com`;
  return callback(null, {HostedZone: {Name: calcDomainName}});
});
AWS.mock("Route53", "changeResourceRecordSets", (params, callback) => {
  const {ChangeBatch: {Changes}} = params;
  const extractedChanges = Changes.map((change) => {
    const {ResourceRecordSet: {Name, ResourceRecords: [{Value}], Type}} = change;
    return {Name, Value, Type};
  });
  return callback(null, {ChangeInfo: {Id: calculateChangeId(extractedChanges)}});
});

/* Tests */
test("Gets a Promise resolving to the proper change id", () => {
  expect.assertions(1);
  return expect(verifyDomain(hostedZoneId, "UPSERT")).resolves.toEqual({domainName, changeId: refChangeId});
});

test("Gets a Promise resolving to the proper change id for a CREATE request", () => {
  /* TODO: Repeat set up to simulate update */
  expect.assertions(1);
  return expect(handler({RequestType: "Create", ResourceProperties: {HostedZoneId: hostedZoneId}, OldResourceProperties: null}))
    .resolves.toEqual({domainName, data: {changeId: refChangeId}});
});

test("Gets a Promise resolving to the proper change id for a UPDATE request", () => {
  expect.assertions(1);
  return expect(handler({
    RequestType: "Update",
    ResourceProperties: {HostedZoneId: hostedZoneId},
    OldResourceProperties: {HostedZoneId: altHostedZoneId}
  }))
    .resolves.toEqual({domainName, data: {newChangeId: refChangeId, oldChangeId: altRefChangeId, oldDomainName: altDomainName}});
});

test("Gets a Promise resolving to the proper change id for a DELETE request", () => {
  expect.assertions(1);
  return expect(handler({RequestType: "Delete", ResourceProperties: {HostedZoneId: hostedZoneId}, OldResourceProperties: null}))
    .resolves.toEqual({domainName, data: {changeId: refChangeId}});
});

describe("Test errors", () => {
  test("Gets a Promise rejecting for a (non-existant) FOO request", () => {
    expect.assertions(1);
    return expect(handler({RequestType: "Foo", ResourceProperties: {HostedZoneId: hostedZoneId}, OldResourceProperties: null}))
      .rejects.toBeInstanceOf(Error);
  });

  test("Gets a Promise rejecting for an invalid CREATE request", () => {
    expect.assertions(1);
    return expect(handler({RequestType: "Create", ResourceProperties: {HostedZoneId: null}, OldResourceProperties: null}))
      .rejects.toBeInstanceOf(Error);
  });

  test("Gets a Promise rejecting for an invalid UPDATE request", () => {
    expect.assertions(1);
    return expect(handler({RequestType: "Update", ResourceProperties: {HostedZoneId: hostedZoneId}, OldResourceProperties: null}))
      .rejects.toBeInstanceOf(Error);
  });

  test("Gets a Promise rejecting for an invalid DELETE request", () => {
    expect.assertions(1);
    return expect(handler({RequestType: "Delete", ResourceProperties: {HostedZoneId: null}, OldResourceProperties: null}))
      .rejects.toBeInstanceOf(Error);
  });
});
