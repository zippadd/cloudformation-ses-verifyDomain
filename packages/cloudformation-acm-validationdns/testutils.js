const crypto = require("crypto");

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

const validationValueSuffix = "acm-validations.aws";
/**
 * Gets a reference change id deterministically to verify results
 * @param {Array.Object} domainNameMappings Array of domain name mappings in form {fqdn, nameValidatorId, valueValidatorId}
 * @return {string} Reference change id for verification
 */
const getRefChangeId = (domainNameMappings) => {
  const totalRecords = [];
  for (const domainNameMapping of domainNameMappings) {
    const {fqdn, nameValidatorId, valueValidatorId} = domainNameMapping;
    totalRecords.push({
      Name: `_${nameValidatorId}.${fqdn}`,
      Value: `_${valueValidatorId}.${validationValueSuffix}`,
      Type: "CNAME"
    });
  }
  return calculateChangeId(totalRecords);
};

const certificateArnForm = "arn:aws:acm:region:000000000000:certificate/";

/**
 * Returns a newly generated certificate id
 * @returns {string} A new generated certificate id
 */
const getNewCertificateId = () => {
  return `${certificateArnForm}${getRandId()}`;
};

module.exports = {
  getRandId,
  calculateChangeId,
  getDigest,
  getRefChangeId,
  getNewCertificateId,
  validationValueSuffix
};
