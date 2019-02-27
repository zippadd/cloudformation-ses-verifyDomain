/* eslint-disable max-lines */
jest.mock("cfn-custom-resource");

const {getZoneIdByName, getZoneIdByFQDN, lookupCertificate, publishCertValidationDNS, handler} = require("./index");
const AWS = require("aws-sdk-mock");
const AWS_SDK = require("aws-sdk");
const {sendSuccess, sendFailure, DEFAULT_PHYSICAL_RESOURCE_ID} = require("cfn-custom-resource");
const {getRandId, calculateChangeId, getDigest, getRefChangeId, getNewCertificateId, validationValueSuffix} = require("./testutils.js");

sendSuccess.mockImplementation((physicalResourceId, data) => {
  return Promise.resolve({id: physicalResourceId, data});
});

sendFailure.mockImplementation((err) => {
  return Promise.reject(err);
});

AWS.setSDKInstance(AWS_SDK);

/* Set Up */
const hostedZoneId = getRandId();
const domainName = `${getDigest(hostedZoneId)}.com`;
const certFQDN = `test.${domainName}`;
const sanCertFQDN = `san.${domainName}`;
const certId = getNewCertificateId();

const subHostedZoneId = getRandId();
const subDomainName = `sub.${domainName}`;
const subCertFQDN = `test.${subDomainName}`;

const altHostedZoneId = getRandId();
const altDomainName = `${getDigest(altHostedZoneId)}.com`;
const altCertFQDN = `alt.${altDomainName}`;
const altCertId = getNewCertificateId();

const fakeHostedZoneId = getRandId();
const fakeDomainName = `${getDigest(fakeHostedZoneId)}.com`;
const fakeCertFQDN = `fake.${fakeDomainName}`;
const fakeCertId = getNewCertificateId();

const fakeHostedZoneId2 = getRandId();
const fakeDomainName2 = `${getDigest(fakeHostedZoneId2)}.com`;
const fakeCertFQDN2 = `${fakeDomainName2}`;
const fakeCertId2 = getNewCertificateId();

const nameRecordId = getRandId();
const valueRecordId = getRandId();
const sanNameRecordId = getRandId();
const sanValueRecordId = getRandId();
const subNameRecordId = getRandId();
const subValueRecordId = getRandId();
const refChangeId = getRefChangeId([
  {
    fqdn: certFQDN,
    nameValidatorId: nameRecordId,
    valueValidatorId: valueRecordId
  },
  {
    fqdn: sanCertFQDN,
    nameValidatorId: sanNameRecordId,
    valueValidatorId: sanValueRecordId
  }
]);
const subRefChangeId = getRefChangeId([
  {
    fqdn: subCertFQDN,
    nameValidatorId: subNameRecordId,
    valueValidatorId: subValueRecordId
  }
]);

const altNameRecordId = getRandId();
const altValueRecordId = getRandId();
const altRefChangeId = getRefChangeId([
  {
    fqdn: altCertFQDN,
    nameValidatorId: altNameRecordId,
    valueValidatorId: altValueRecordId
  }
]);


/* Set Up AWS Mocks */
AWS.mock("Route53", "changeResourceRecordSets", jest.fn((params, callback) => {
  const {ChangeBatch: {Changes}} = params;
  const extractedChanges = Changes.map((change) => {
    const {ResourceRecordSet: {Name, ResourceRecords: [{Value}], Type}} = change;
    if (Name.includes(fakeDomainName2)) {
      return callback(new Error("Unable to process change"), null);
    }
    return {Name, Value, Type};
  });
  return callback(null, {ChangeInfo: {Id: calculateChangeId(extractedChanges)}});
}));
AWS.mock("Route53", "listHostedZonesByName", (params, callback) => {
  const {DNSName} = params;
  let zoneId, zoneName;

  switch (DNSName) {
  case `${domainName}`:
  case `${domainName}.`:
    zoneId = hostedZoneId;
    zoneName = domainName;
    break;
  case `${altDomainName}`:
  case `${altDomainName}.`:
    zoneId = altHostedZoneId;
    zoneName = altDomainName;
    break;
  case `${subDomainName}`:
  case `${subDomainName}.`:
    zoneId = subHostedZoneId;
    zoneName = subDomainName;
    break;
  case `${fakeDomainName}`:
  case `${fakeDomainName}.`:
    zoneId = fakeHostedZoneId;
    zoneName = fakeDomainName;
    break;
  case `${fakeDomainName2}`:
  case `${fakeDomainName2}.`:
    zoneId = fakeHostedZoneId2;
    zoneName = fakeDomainName2;
    break;
  case "ap.domain.com":
  case "ap.domain.com.":
    zoneId = getRandId();
    zoneName = "zap.domain.com";
    break;
  default:
    zoneId = "";
    zoneName = "";
  }

  const zones = zoneId === "" || zoneName === "" ?
    [] :
    [
      {
        Id: `/hostedzone/${zoneId}`,
        Name: `${zoneName}.`
      }
    ];

  return callback(null, {HostedZones: zones});
});
AWS.mock("Route53", "testDNSAnswer", (params, callback) => {
  const {HostedZoneId, RecordName, RecordType} = params;
  let recordData;

  if (RecordType !== "NS") {
    return callback(new Error("Invalid record type for this test"));
  }

  switch (HostedZoneId) {
  case hostedZoneId:
    if (RecordName !== certFQDN && RecordName !== sanCertFQDN && RecordName !== subCertFQDN) {
      return callback(new Error("Invalid lookup"));
    }
    recordData = RecordName === certFQDN || RecordName === sanCertFQDN ? [] : [`ns.${getRandId()}.com`];
    break;
  case altHostedZoneId:
    if (RecordName !== altCertFQDN) {
      return callback(new Error("Invalid lookup"));
    }
    recordData = [];
    break;
  case subHostedZoneId:
    if (RecordName !== subCertFQDN) {
      return callback(new Error("Invalid lookup"));
    }
    recordData = [];
    break;
  case fakeHostedZoneId:
    recordData = [fakeDomainName];
    break;
  case fakeHostedZoneId2:
    recordData = [];
    break;
  default:
    return callback(new Error("Invalid zone id"), null);
  }

  return callback(null, {RecordData: recordData});
});
AWS.mock("ACM", "describeCertificate", (params, callback) => {
  const {CertificateArn} = params;
  let certData;

  switch (CertificateArn) {
  case certId:
    certData = {
      CertificateArn,
      DomainName: certFQDN,
      SubjectAlternativeNames: [subCertFQDN, sanCertFQDN],
      DomainValidationOptions: [
        {
          DomainName: certFQDN,
          ValidationStatus: "PENDING_VALIDATION",
          ResourceRecord: {
            Name: `_${nameRecordId}.${certFQDN}`,
            Type: "CNAME",
            Value: `_${valueRecordId}.${validationValueSuffix}`
          }
        },
        {
          DomainName: subCertFQDN,
          ValidationStatus: "PENDING_VALIDATION",
          ResourceRecord: {
            Name: `_${subNameRecordId}.${subCertFQDN}`,
            Type: "CNAME",
            Value: `_${subValueRecordId}.${validationValueSuffix}`
          }
        },
        {
          DomainName: `${getRandId()}.com`,
          ValidationStatus: "SUCCESS",
          ResourceRecord: {
            Name: `_${getRandId()}.${getRandId()}.com`,
            Type: "CNAME",
            Value: `_${getRandId()}.${validationValueSuffix}`
          }
        },
        {
          DomainName: sanCertFQDN,
          ValidationStatus: "PENDING_VALIDATION",
          ResourceRecord: {
            Name: `_${sanNameRecordId}.${sanCertFQDN}`,
            Type: "CNAME",
            Value: `_${sanValueRecordId}.${validationValueSuffix}`
          }
        }
      ],
      Status: "PENDING_VALIDATION",
      Type: "AMAZON_ISSUED"
    };
    break;
  case altCertId:
    certData = {
      CertificateArn,
      DomainName: altCertFQDN,
      SubjectAlternativeNames: [],
      DomainValidationOptions: [
        {
          DomainName: altCertFQDN,
          ValidationStatus: "PENDING_VALIDATION",
          ResourceRecord: {
            Name: `_${altNameRecordId}.${altCertFQDN}`,
            Type: "CNAME",
            Value: `_${altValueRecordId}.${validationValueSuffix}`
          }
        }
      ],
      Status: "PENDING_VALIDATION",
      Type: "AMAZON_ISSUED"
    };
    break;
  case fakeCertId:
    certData = {
      CertificateArn,
      DomainName: fakeCertFQDN,
      SubjectAlternativeNames: [],
      Status: "PENDING_VALIDATION",
      Type: "IMPORTED"
    };
    break;
  case fakeCertId2:
    certData = {
      CertificateArn,
      DomainName: fakeCertFQDN2,
      SubjectAlternativeNames: [],
      DomainValidationOptions: [
        {
          DomainName: fakeCertFQDN2,
          ValidationStatus: "PENDING_VALIDATION",
          ResourceRecord: {
            Name: `_${getRandId()}.${fakeCertFQDN2}`,
            Type: "CNAME",
            Value: `_${getRandId()}.${validationValueSuffix}`
          }
        }
      ],
      Status: "PENDING_VALIDATION",
      Type: "AMAZON_ISSUED"
    };
    break;
  default:
    certData = {
      CertificateArn,
      DomainName: `${getRandId}.com`,
      SubjectAlternativeNames: [],
      Status: "PENDING_VALIDATION",
      Type: "IMPORTED"
    };
  }

  return callback(null, {Certificate: certData});
});

/**
 * Validates the params for ACM listCertificates mocks
 * @param {object} params AWS SDK call params
 * @returns {void}        Throws if validation error
 */
const pendingValidationCheck = (params) => {
  const {CertificateStatuses} = params;

  if (!CertificateStatuses.some((certificateStatus) => {
    return certificateStatus === "PENDING_VALIDATION";
  })) {
    throw new Error("Must filter to pending validation certs");
  }
};

/**
 * Mocks a basic list of certificates
 * @param {object} params       AWS SDK call params
 * @param {function} callback   AWS SDK callback
 * @returns {function}          Callback for execution
 */
const acmListCertificatesBasic = (params, callback) => {
  try {
    pendingValidationCheck(params);
  } catch (err) {
    return callback(err, null);
  }

  const certificates = [
    {
      CertificateArn: certId,
      DomainName: certFQDN
    },
    {
      CertificateArn: altCertId,
      DomainName: altCertFQDN
    },
    {
      CertificateArn: fakeCertId,
      DomainName: fakeCertFQDN
    }
  ];

  return callback(null, {CertificateSummaryList: certificates});
};

/**
 * Mocks a large list of certificates
 * @param {object} params       AWS SDK call params
 * @param {function} callback   AWS SDK callback
 * @returns {function}          Callback for execution
 */
const acmListCertificatesLarge = (params, callback) => {
  pendingValidationCheck(params);
  const {NextToken} = params;
  const certificates = [];
  const FULL_CERT_LIST = 1000;
  const PARTIAL_CERT_LIST = 500;
  const numCertsToGen = NextToken ? PARTIAL_CERT_LIST : FULL_CERT_LIST;

  for (let certNum = 0; certNum <= numCertsToGen; certNum++) {
    certificates.push({
      CertificateArn: getNewCertificateId(),
      DomainName: `${getRandId()}.com`
    });
  }

  if (NextToken) {
    certificates.push({
      CertificateArn: certId,
      DomainName: certFQDN
    });
  }

  const response = {CertificateSummaryList: certificates};

  if (!NextToken) {
    response.NextToken = getRandId();
  }

  return callback(null, response);
};

let acmTimeDelayPassed = false;
/**
 * Mocks a list of certificates where there is a delay
 * @param {object} params       AWS SDK call params
 * @param {function} callback   AWS SDK callback
 * @returns {function}          Callback for execution
 */
const acmListCertificatesDelayed = (params, callback) => {
  pendingValidationCheck(params);
  const certificates = [];

  if (acmTimeDelayPassed) {
    certificates.push({
      CertificateArn: certId,
      DomainName: certFQDN
    });
  }

  return callback(null, {CertificateSummaryList: certificates});
};

/**
 * Mocks a list of certificates where there is a delay
 * @param {object} params       AWS SDK call params
 * @param {function} callback   AWS SDK callback
 * @returns {function}          Callback for execution
 */
const acmListCertificatesNone = (params, callback) => {
  pendingValidationCheck(params);

  return callback(null, {CertificateSummaryList: []});
};

/* Tests */
describe("Test getting zone id by name", () => {
  test("Gets a Promise resolving to the proper zone id for primary zone", () => {
    expect.assertions(1);
    return expect(getZoneIdByName(domainName)).resolves.toEqual(hostedZoneId);
  });

  test("Gets a Promise resolving to the proper zone id for primary zone with a trailing period", () => {
    expect.assertions(1);
    return expect(getZoneIdByName(`${domainName}.`)).resolves.toEqual(hostedZoneId);
  });

  test("Gets a Promise resolving to the proper zone id for alt zone", () => {
    expect.assertions(1);
    return expect(getZoneIdByName(altDomainName)).resolves.toEqual(altHostedZoneId);
  });

  test("Gets a Promise resolving to an empty string for an non-existent domain in R53", () => {
    expect.assertions(1);
    return expect(getZoneIdByName("jkiuyybygjgjgjguuytuituytuytuytyvtttiutytuy.com")).rejects.toBeInstanceOf(Error);
  });

  test("Gets a Promise resolving to an empty string for an non-exact match to domain in R53", () => {
    expect.assertions(1);
    return expect(getZoneIdByName("ap.domain.com")).rejects.toBeInstanceOf(Error);
  });
});

describe("Test getting zone by FQDN", () => {
  test("Gets a Promise resolving to the proper zone id for primary FQDN", () => {
    expect.assertions(1);
    return expect(getZoneIdByFQDN(certFQDN)).resolves.toEqual(hostedZoneId);
  });

  test("Gets a Promise resolving to the proper zone id for sub FQDN", () => {
    expect.assertions(1);
    return expect(getZoneIdByFQDN(subCertFQDN)).resolves.toEqual(subHostedZoneId);
  });

  test("Gets a Promise resolving to the proper zone id for alt FQDN", () => {
    expect.assertions(1);
    return expect(getZoneIdByFQDN(altCertFQDN)).resolves.toEqual(altHostedZoneId);
  });

  test("Gets a Promise resolving to the proper zone id for alt FQDN with period at the end", () => {
    expect.assertions(1);
    return expect(getZoneIdByFQDN(`${altCertFQDN}.`)).resolves.toEqual(altHostedZoneId);
  });

  test("Gets a Promise rejecting for a FQDN with invalid DNS", () => {
    expect.assertions(1);
    return expect(getZoneIdByFQDN(fakeCertFQDN)).rejects.toBeInstanceOf(Error);
  });

  test("Gets a Promise rejecting for an invalid FQDN", () => {
    expect.assertions(1);
    return expect(getZoneIdByFQDN("")).rejects.toBeInstanceOf(Error);
  });
});

describe("Test looking up the certificate", () => {
  beforeEach(() => {
    AWS.restore("ACM", "listCertificates");
  });

  test("Gets a Promise resolving to the proper certificate id for a basic lookup", () => {
    AWS.mock("ACM", "listCertificates", acmListCertificatesBasic);
    expect.assertions(1);
    const result = expect(lookupCertificate(certFQDN)).resolves.toEqual(certId);
    return result;
  });

  test("Gets a Promise resolving to the proper certificate id for a large lookup", () => {
    AWS.mock("ACM", "listCertificates", acmListCertificatesLarge);
    expect.assertions(1);
    const NUM_OF_MS_TO_TIMEOUT = 2000;
    const result = expect(lookupCertificate(certFQDN, NUM_OF_MS_TO_TIMEOUT)).resolves.toEqual(certId);
    return result;
  });

  test("Gets a Promise resolving to the proper certificate id for a delayed lookup", () => {
    AWS.mock("ACM", "listCertificates", acmListCertificatesDelayed);
    expect.assertions(1);
    const NUM_OF_SECS_TO_DELAY = 3000;
    setTimeout(() => {
      acmTimeDelayPassed = true;
    }, NUM_OF_SECS_TO_DELAY);
    const result = expect(lookupCertificate(certFQDN)).resolves.toEqual(certId);
    return result;
  });

  test("Gets a Promise rejecting to an error for a non-existent certificate", async () => {
    AWS.mock("ACM", "listCertificates", acmListCertificatesNone);
    expect.assertions(1);
    const NUM_OF_MS_TO_TIMEOUT = 2000;
    const result = await expect(lookupCertificate(certFQDN, NUM_OF_MS_TO_TIMEOUT)).rejects.toBeInstanceOf(Error);
    return result;
  });
});

describe("Publishing the certificate validation DNS", () => {
  test("Gets a Promise resolving to the proper change id for a basic publish on alt", () => {
    expect.assertions(1);
    const result = expect(publishCertValidationDNS(altCertId, "UPSERT")).resolves.toEqual([altRefChangeId]);
    return result;
  });

  test("Gets a Promise resolving to the proper set of change id for an advanced publish on primary", () => {
    expect.assertions(1);
    const changeIds = [];
    const zoneChangeIdMap = {hostedZoneId: refChangeId, subHostedZoneId: subRefChangeId};
    for (const zoneId of Object.keys(zoneChangeIdMap)) {
      changeIds.push(zoneChangeIdMap[zoneId]);
    }
    const result = expect(publishCertValidationDNS(certId, "UPSERT")).resolves.toEqual(changeIds);
    return result;
  });

  test("Gets a Promise resolving to the proper set of change id for an advanced delete on primary", () => {
    expect.assertions(1);
    const changeIds = [];
    const zoneChangeIdMap = {hostedZoneId: refChangeId, subHostedZoneId: subRefChangeId};
    for (const zoneId of Object.keys(zoneChangeIdMap)) {
      changeIds.push(zoneChangeIdMap[zoneId]);
    }
    const result = expect(publishCertValidationDNS(certId, "DELETE")).resolves.toEqual(changeIds);
    return result;
  });

  test("Gets a Promise resolving to the proper set of change id for a delete on fake", () => {
    expect.assertions(1);
    const result = expect(publishCertValidationDNS(fakeCertId2, "DELETE")).resolves.toEqual([null]);
    return result;
  });
});

/**
 * Mocks the context function to provide remaining time in ms
 * @return {Number} Remaining time in ms
 */
const getRemainingTimeInMillis = () => {
  const REMAINING_TIME_IN_MS = 10000;
  return REMAINING_TIME_IN_MS;
};

describe("Test handler", () => {
  beforeEach(() => {
    AWS.restore("ACM", "listCertificates");
    AWS.mock("ACM", "listCertificates", acmListCertificatesBasic);
  });
  test("Gets a Promise resolving to the proper change id for a CREATE request", () => {
    /* TODO: Repeat set up to simulate update */
    expect.assertions(1);
    return expect(handler(
      {RequestType: "Create", ResourceProperties: {CertificateFQDN: certFQDN}, OldResourceProperties: null},
      {getRemainingTimeInMillis}
    ))
      .resolves.toEqual({id: certId, data: {changeIds: [refChangeId, subRefChangeId]}});
  });

  test("Gets a Promise resolving to the proper change id for a UPDATE request", () => {
    /* TODO: Repeat set up to simulate update */
    expect.assertions(1);
    return expect(handler(
      {
        RequestType: "Update",
        ResourceProperties: {CertificateFQDN: certFQDN},
        OldResourceProperties: {CertificateFQDN: altCertFQDN},
        PhysicalResourceId: altCertId
      },
      {getRemainingTimeInMillis}
    ))
      .resolves.toEqual({
        id: certId,
        data: {
          changeIds: [refChangeId, subRefChangeId],
          oldCertificateArn: altCertId,
          oldChangeIds: [altRefChangeId]
        }
      });
  });

  test("Gets a Promise resolving to the proper change id for a DELETE request", () => {
    /* TODO: Repeat set up to simulate update */
    expect.assertions(1);
    return expect(handler(
      {RequestType: "Delete", ResourceProperties: {CertificateFQDN: certFQDN}, OldResourceProperties: null, PhysicalResourceId: certId},
      {getRemainingTimeInMillis}
    ))
      .resolves.toEqual({id: certId, data: {changeIds: [refChangeId, subRefChangeId]}});
  });

  test("Gets a Promise rejecting to an error for a IMPORTED cert for a CREATE request", () => {
    /* TODO: Repeat set up to simulate update */
    expect.assertions(1);
    return expect(handler(
      {RequestType: "Create", ResourceProperties: {CertificateFQDN: fakeCertFQDN}, OldResourceProperties: null},
      {getRemainingTimeInMillis}
    ))
      .rejects.toBeInstanceOf(Error);
  });

  test("Gets a Promise resolving for a IMPORTED cert for a DELETE request with the default physical resource id", () => {
    /* TODO: Repeat set up to simulate update */
    expect.assertions(1);
    return expect(handler(
      {
        RequestType: "Delete",
        ResourceProperties: {CertificateFQDN: fakeCertFQDN},
        OldResourceProperties: null,
        PhysicalResourceId: DEFAULT_PHYSICAL_RESOURCE_ID
      },
      {getRemainingTimeInMillis}
    ))
      .resolves.toEqual({id: DEFAULT_PHYSICAL_RESOURCE_ID, data: null});
  });
});
