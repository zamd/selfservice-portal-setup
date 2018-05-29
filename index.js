const rp = require("request-promise-native");
const inquirer = require("inquirer");
const path = require("path");
const jwt_decode = require("jwt-decode");
const url = require("url");
const _ = require("lodash");
const chalk = require("chalk");
const util = require("util");
const os = require('os');
const readFileAsync = util.promisify(require("fs").readFile);
const writeFileAsync = util.promisify(require("fs").writeFile);
const existsAync = util.promisify(require("fs").exists);

const normalizeUrl = require('normalize-url');
const validUrl = require('valid-url');


function delay(timeout) {
  return new Promise((resolve)=>setTimeout(()=>resolve(),timeout));
}
async function findConnections(strategy) {
  const baseUrl = "https://" + path.join(config.domain, "api/v2");

  const resp = await rp({
    uri: `${baseUrl}/connections?strategy=${strategy}&fields=name`,
    headers: {
      Authorization: `Bearer ${config.token}`
    }
  });
  const connections = JSON.parse(resp);
  return connections.map(c => ({ name: c.name, value: c.id }));
}

async function validateConnections(
  ad_connections,
  sms_connections,
  email_connections
) {
  if (ad_connections.length < 1) {
    console.log(
      chalk.red.bold(
        "AD connection is required. Please setup an AD connection and rerun the script."
      )
    );
    process.exit(0);
  }
  if (sms_connections.length < 1) {
    console.log(
      chalk.red.bold(
        "SMS passwordless connection is required. Please setup passwordless SMS and rerun the script."
      )
    );
    process.exit(0);
  }
  if (email_connections.length < 1) {
    console.log(
      chalk.red.bold(
        "Email passwordless connection is required. Please setup passwordless Email and rerun the script."
      )
    );
    process.exit(0);
  }

  const askConnections = [
    {
      name: "selected_ad_connection",
      type: "list",
      message: "Please select an AD connection.",
      choices: ad_connections
    },
    {
      name: "selected_sms_connection",
      type: "list",
      message: "Please select an SMS passwordless connection.",
      choices: sms_connections
    },
    {
      name: "selected_email_connection",
      type: "list",
      message: "Please select an email passwordless connection.",
      choices: email_connections
    }
  ];

  return await inquirer.prompt(askConnections);
}

async function getAndValidateConfig() {
  const questions = [
    {
      name: "domain",
      message: "Please enter Auth0 tenant domain.",

      validate: async domain => {
        const testEndpoint = "https://" + path.join(domain, "test");
        try {
          await rp(testEndpoint);
          return true;
        } catch (ex) {
          return "Please enter a valid domain in {tenant}.auth0.com format.";
        }
      }
    },
    {
      name: "token",
      message: "Please enter management api token with " + chalk.bold("create:clients, create:rules, create:resource_servers, create:client_grants, read:connections update:connection scopes."),
      default: async () => {
        const tokenFile = path.join(__dirname, "token.txt");
        if (await existsAync(tokenFile)) {
          const data = await readFileAsync(tokenFile, "utf-8");
          return data.trim();
        }
        return undefined;
      },
      validate: (token, answers) => {
        const claims = jwt_decode(token);

        if (claims && claims.iss) {
          const parts = url.parse(claims.iss);
          if (parts.host !== answers.domain) {
            return `Issuer (${
              parts.host
            }) of the token does not match the domain (${answers.domain})`;
          }
        }

        if (claims.scope) {
          const requiredScopes = [
            "create:clients",
            "create:rules",
            "create:resource_servers",
            "create:client_grants",
            "update:connections",
            "read:connections"
          ];
          const missingScopes = _.difference(
            requiredScopes,
            claims.scope.split(" ")
          );
          if (missingScopes.length > 0) {
            console.log(claims.scope);
            return `Required scopes missing ${missingScopes}`;
          }
        }

        return true;
      }
    },
    {
      name: "portal_url",
      validate: (url) => {
        if (!validUrl.isWebUri(url))
          return "Please enter a valid http(s) url.";
        return true;
      },
      message: "Please enter public url of the portal deployment."
    }
  ];

  const answers =  await inquirer.prompt(questions);
  answers.portal_url = normalizeUrl(answers.portal_url); // removing trailing slash

  return answers;
}


async function handleError(err, failedOperation) {
  if (err.statusCode && err.statusCode===429) {
    const DELAY_SECONDS = 5;
    console.log(chalk.yellow.bold(`rate limited, waiting for ${DELAY_SECONDS}s before retyring..`));
    await delay(DELAY_SECONDS*1000);
    return failedOperation();
  }
  else {
    console.log(chalk.red.bold(err.toString()));
  }
}

async function createEntity(entity, payload) {
  console.log(chalk.green.bold(`creating ${entity}...`));
  const url = `https://${config.domain}/api/v2/${entity}`;

  try {
    return await rp({
      uri: url,
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`
      },
      json: payload
    });
  } 
  catch (err) {
      return await handleError(err, ()=> createEntity(entity,payload) );
  }
}

async function getEntity(entity, id) {
  const url = `https://${config.domain}/api/v2/${entity}/${id}`;

  try {
    const resp = await rp({
      uri: url,
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.token}`
      }
    });

    return JSON.parse(resp);
  } catch (err) {
    return await handleError(err, ()=> getEntity(entity,id) );
  }
}

async function patchEntity(entity, id, payload) {
  const url = `https://${config.domain}/api/v2/${entity}/${id}`;

  try {
    return await rp({
      uri: url,
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${config.token}`
      },
      json: payload
    });
  } catch (err) {
    return await handleError(err, ()=> patchEntity(entity,id,payload) );
  }
}

async function createPortalClient() {
  const pageHtml = await readFileAsync(
    path.join(__dirname, "portal_login.html"),
    "utf-8"
  );
  const portal = {
    name: "Self Service Portal",
    callbacks: [`${config.portal_url}/callback`],
    jwt_configuration: {
      alg: "RS256"
    },
    custom_login_page: pageHtml,
    custom_login_page_on: true,
    app_type: "spa",
    grant_types: ["authorization_code", "implicit"]
  };
  return createEntity("clients", portal);
}

function createBackendClient() {
  const backend = {
    name: "Self Service Backend",
    app_type: "non_interactive",
    grant_types: [
      "client_credentials",
      "http://auth0.com/oauth/grant-type/password-realm",
      "http://auth0.com/oauth/legacy/grant-type/ro",
      "password"
    ]
  };
  return createEntity("clients", backend);
}

function createBackendAPI() {
  const api = {
    name: "Self Service API",
    identifier: "urn:self-service-portal-api",
    scopes: [
      {
        value: "change:password",
        description: "Change Password"
      },
      {
        value: "reset:password",
        description: "Reset Password"
      },
      {
        value: "update:enrolment",
        description: "Update Enrolment"
      },
      {
        value: "create:enrolment",
        description: "Create Enrolment"
      },
      {
        value: "read:enrolment",
        description: "Read Enrolment"
      },
      {
        value: "delete:enrolment",
        description: "delete:enrolment"
      }
    ]
  };
  return createEntity("resource-servers", api);
}

async function createRule() {
  const ruleCode = await readFileAsync(
    path.join(__dirname, "issue_scopes_rule.js"),
    "utf-8"
  );

  const api = {
    name: "Self Service Issue Scopes",
    script: ruleCode,
    enabled: true
  };
  return createEntity("rules", api);
}

function createMgmtApiGrant(backendClient) {
  const aud = `https://${config.domain}/api/v2/`;
  const client_grant = {
    client_id: backendClient.client_id,
    audience: aud,
    scope: ["read:users", "update:users", "delete:users"]
  };

  return createEntity("client-grants", client_grant);
}

async function enableConnections(artefacts, selectedConnections) {
  const ps = Object.keys(selectedConnections).map(k =>
    getEntity("connections", selectedConnections[k])
  );
  const cons = await Promise.all(ps);

  const patches = cons.map(c => ({
    id: c.id,
    patch: {
      enabled_clients: _.concat(c.enabled_clients, [
        artefacts.portal.client_id,
        artefacts.backend.client_id
      ]),
      metadata: c.strategy === "ad" ? { username_field_name: "sAMAccountName" } : {}
    }
  }));

  return await Promise.all(
    patches.map(p => patchEntity("connections", p.id, p.patch))
  );
}
async function createArtefacts() {
  const artefacts = [
    createPortalClient,
    createBackendClient,
    createBackendAPI,
    createRule
  ].map(f => f());

  const [portal, backend, api, rule] = await Promise.all(artefacts);
  const mgmt_grant = await createMgmtApiGrant(backend);
  return {
    portal,
    backend,
    api,
    rule,
    mgmt_grant
  };
}
async function generateEnv(artefacts) {
  const client_env = `REACT_APP_domain=${config.domain}
REACT_APP_clientID=${artefacts.portal.client_id}
REACT_APP_audience=urn:self-service-portal-api
`;

  const server_env = `NON_INTERACTIVE_CLIENT_ID=${artefacts.backend.client_id}
NON_INTERACTIVE_CLIENT_SECRET=${artefacts.backend.client_secret}
DOMAIN=${config.domain}
AUDIENCE=urn:self-service-portal-api
`;

  await writeFileAsync(path.join(__dirname, "client.env"), client_env, "utf-8");
  await writeFileAsync(path.join(__dirname, "server.env"), server_env, "utf-8");
}
async function runSetup() {
  console.log(chalk.white.bgGreen.bold("Self Service Portal Setup"));
  console.log(os.EOL);

  config = await getAndValidateConfig();

  console.log(chalk.green.bold("analysing tenant..."));

  const strategies = ["ad", "sms", "email"];
  const getConnections = strategies.map(s => findConnections(s));
  const [
    ad_connections,
    sms_connections,
    email_connections
  ] = await Promise.all(getConnections);

  const selectedConnections = await validateConnections(
    ad_connections,
    sms_connections,
    email_connections
  );

  const artefacts = await createArtefacts(config.domain, config.token);
  await enableConnections(artefacts, selectedConnections);
  await generateEnv(artefacts);

  console.log(
    chalk.bgGreen.bold(
      "Done. Copy the generated .env files in respective folders."
    )
  );
}

try {
  runSetup();
} catch (ex) {
  console.log(ex);
}
