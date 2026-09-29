/**
 * Seed 007 — the skills vocabulary.
 * Phase: 8
 *
 * ── WHY A SHARED LIST AND NOT FREE TEXT ───────────────────────────────
 *
 * Free text turns "React", "ReactJS", "React.js" and "react" into four
 * different skills. A consultant claiming one and a job asking for another
 * then fail to match, and nobody can see why — the matcher is working
 * perfectly against data that lies.
 *
 * So a skill is a ROW, and everything points at the row. The `slug` is what
 * collapses the spellings; aliases catch the shorthand ("k8s", "js", "gcp")
 * that nobody writes out in full.
 *
 * ── WHY THIS LIST IS DELIBERATELY NOT EXHAUSTIVE ──────────────────────
 *
 * A hand-written list of every technology in the world is a list that is wrong
 * the week it ships. This one covers the ground a staffing bench actually
 * works across, so the search box is useful on day one — and then
 * services/skillLearner.js grows it from the job postings the system already
 * ingests. A technology that starts appearing in real adverts is added because
 * employers asked for it, not because somebody remembered it.
 *
 * Adding a row here is still fine. It is just not the mechanism this depends on.
 */

/** name → the category it is filed under. */
const SKILLS = {
    'Programming languages': [
        'Java', 'Python', 'JavaScript', 'TypeScript', 'C', 'C++', 'C#', 'Go',
        'Rust', 'Ruby', 'PHP', 'Swift', 'Kotlin', 'Scala', 'Perl', 'R',
        'MATLAB', 'Dart', 'Objective-C', 'Groovy', 'Elixir', 'Haskell',
        'Clojure', 'Lua', 'Julia', 'Visual Basic', 'COBOL', 'Fortran',
        'Assembly', 'Shell Scripting', 'Bash', 'PowerShell', 'SQL', 'PL/SQL',
        'T-SQL', 'VBA', 'Solidity', 'F#', 'Erlang', 'OCaml',
    ],

    'Frontend': [
        'React', 'Angular', 'Vue.js', 'Svelte', 'Next.js', 'Nuxt.js', 'Remix',
        'HTML', 'CSS', 'SASS', 'LESS', 'Tailwind CSS', 'Bootstrap',
        'Material UI', 'Ant Design', 'Chakra UI', 'jQuery', 'Redux', 'MobX',
        'Zustand', 'RxJS', 'Webpack', 'Vite', 'Babel', 'ESLint', 'Storybook',
        'Three.js', 'D3.js', 'WebGL', 'Web Components', 'Responsive Design',
        'Accessibility', 'Progressive Web Apps', 'Micro Frontends',
        'Server-Side Rendering', 'Astro', 'Solid.js', 'Alpine.js', 'Handlebars',
    ],

    'Backend': [
        'Node.js', 'Express.js', 'NestJS', 'Fastify', 'Spring', 'Spring Boot',
        'Hibernate', 'Django', 'Flask', 'FastAPI', 'Ruby on Rails', 'Laravel',
        'Symfony', 'ASP.NET', '.NET Core', 'Micronaut', 'Quarkus', 'Play Framework',
        'REST APIs', 'GraphQL', 'gRPC', 'SOAP', 'WebSockets', 'Microservices',
        'Serverless', 'Event-Driven Architecture', 'Domain-Driven Design',
        'API Gateway', 'OAuth 2.0', 'JWT', 'OpenAPI', 'Swagger', 'tRPC',
    ],

    'Databases': [
        'PostgreSQL', 'MySQL', 'MariaDB', 'Oracle Database', 'SQL Server',
        'SQLite', 'MongoDB', 'Cassandra', 'DynamoDB', 'Redis', 'Elasticsearch',
        'Neo4j', 'CouchDB', 'Firebase', 'Supabase', 'Snowflake', 'BigQuery',
        'Redshift', 'ClickHouse', 'InfluxDB', 'TimescaleDB', 'Db2', 'CockroachDB',
        'Database Design', 'Query Optimization', 'Data Modeling', 'ETL',
        'Stored Procedures', 'Database Migration', 'Sharding', 'Replication',
    ],

    'Cloud': [
        'AWS', 'Microsoft Azure', 'Google Cloud Platform', 'AWS Lambda', 'AWS EC2',
        'AWS S3', 'AWS RDS', 'AWS ECS', 'AWS EKS', 'AWS CloudFormation',
        'Azure Functions', 'Azure DevOps', 'Azure Kubernetes Service',
        'Google Kubernetes Engine', 'Cloud Run', 'Heroku', 'DigitalOcean',
        'Vercel', 'Netlify', 'Cloudflare', 'OpenShift', 'Cloud Migration',
        'Cloud Architecture', 'Cost Optimization', 'Multi-Cloud',
    ],

    'DevOps and infrastructure': [
        'Docker', 'Kubernetes', 'Terraform', 'Ansible', 'Puppet', 'Chef',
        'Jenkins', 'GitHub Actions', 'GitLab CI', 'CircleCI', 'TravisCI',
        'ArgoCD', 'Helm', 'Prometheus', 'Grafana', 'Datadog', 'New Relic',
        'Splunk', 'ELK Stack', 'Nginx', 'Apache', 'HAProxy', 'Linux',
        'Unix', 'Windows Server', 'CI/CD', 'Infrastructure as Code',
        'Site Reliability Engineering', 'Load Balancing', 'Monitoring',
        'Incident Response', 'Vagrant', 'Packer', 'Consul', 'Istio',
    ],

    'Data and analytics': [
        'Apache Spark', 'Hadoop', 'Apache Kafka', 'Apache Airflow', 'dbt',
        'Apache Flink', 'Databricks', 'Pandas', 'NumPy', 'Data Warehousing',
        'Data Pipelines', 'Data Engineering', 'Business Intelligence', 'Tableau',
        'Power BI', 'Looker', 'QlikView', 'Apache NiFi', 'Talend', 'Informatica',
        'SSIS', 'SSRS', 'Data Governance', 'Data Quality', 'Data Visualization',
        'Statistical Analysis', 'A/B Testing', 'Excel',
    ],

    'AI and machine learning': [
        'Machine Learning', 'Deep Learning', 'TensorFlow', 'PyTorch', 'Keras',
        'Scikit-learn', 'XGBoost', 'Natural Language Processing', 'Computer Vision',
        'Reinforcement Learning', 'Large Language Models', 'Generative AI',
        'Prompt Engineering', 'LangChain', 'Hugging Face', 'MLOps',
        'Model Deployment', 'Feature Engineering', 'Neural Networks',
        'Recommendation Systems', 'Time Series Analysis', 'OpenCV',
        'Vector Databases', 'RAG', 'Fine-Tuning',
    ],

    'Mobile': [
        'Android', 'iOS', 'React Native', 'Flutter', 'Xamarin', 'Ionic',
        'SwiftUI', 'Jetpack Compose', 'Android SDK', 'Core Data', 'Firebase',
        'Mobile App Development', 'App Store Deployment', 'Push Notifications',
    ],

    'Testing and quality': [
        'Unit Testing', 'Integration Testing', 'Test Automation', 'Selenium',
        'Cypress', 'Playwright', 'Jest', 'Mocha', 'JUnit', 'TestNG', 'PyTest',
        'Cucumber', 'Appium', 'Postman', 'JMeter', 'LoadRunner', 'SonarQube',
        'Test-Driven Development', 'Behaviour-Driven Development',
        'Performance Testing', 'Regression Testing', 'Manual Testing',
        'QA Automation', 'API Testing', 'Accessibility Testing',
    ],

    'Security': [
        'Application Security', 'Penetration Testing', 'OWASP', 'Cryptography',
        'Identity and Access Management', 'SAML', 'Single Sign-On',
        'Vulnerability Assessment', 'Security Auditing', 'SIEM', 'Firewalls',
        'Network Security', 'Zero Trust', 'GDPR Compliance', 'SOC 2',
        'HIPAA Compliance', 'PCI DSS', 'Threat Modeling', 'Incident Management',
    ],

    'Tools and practice': [
        'Git', 'GitHub', 'GitLab', 'Bitbucket', 'Jira', 'Confluence', 'Trello',
        'Asana', 'Slack', 'Figma', 'Adobe XD', 'Notion', 'ServiceNow',
        'Agile', 'Scrum', 'Kanban', 'SAFe', 'Waterfall', 'Code Review',
        'Pair Programming', 'Technical Documentation', 'System Design',
        'Design Patterns', 'Refactoring', 'Debugging', 'Version Control',
    ],

    'Enterprise and ERP': [
        'SAP', 'SAP ABAP', 'SAP HANA', 'Salesforce', 'Salesforce Apex',
        'Dynamics 365', 'Workday', 'Oracle ERP', 'NetSuite', 'PeopleSoft',
        'SharePoint', 'Power Apps', 'Power Automate', 'Mulesoft', 'Boomi',
        'Informatica MDM', 'Pega', 'Appian', 'UiPath', 'Blue Prism',
        'Automation Anywhere', 'Robotic Process Automation',
    ],

    'Professional': [
        'Communication', 'Problem Solving', 'Team Leadership', 'Mentoring',
        'Stakeholder Management', 'Project Management', 'Product Management',
        'Requirements Gathering', 'Client Interaction', 'Presentation Skills',
        'Cross-Functional Collaboration', 'Time Management', 'Analytical Thinking',
        'Technical Writing', 'Onboarding and Training',
    ],
};

/**
 * Shorthand people actually type, mapped to the canonical skill.
 *
 * Without these, a consultant typing "k8s" finds nothing and adds a duplicate
 * custom skill, which is exactly the fragmentation the table exists to stop.
 */
const ALIASES = {
    JavaScript: ['js', 'ecmascript', 'es6'],
    TypeScript: ['ts'],
    'Node.js': ['node', 'nodejs'],
    'Vue.js': ['vue', 'vuejs'],
    React: ['reactjs', 'react.js'],
    'Next.js': ['nextjs'],
    Kubernetes: ['k8s', 'kubernets'],
    'Google Cloud Platform': ['gcp', 'google cloud'],
    'Microsoft Azure': ['azure'],
    AWS: ['amazon web services'],
    PostgreSQL: ['postgres', 'psql'],
    'SQL Server': ['mssql', 'microsoft sql server'],
    MongoDB: ['mongo'],
    'Machine Learning': ['ml'],
    'Deep Learning': ['dl'],
    'Natural Language Processing': ['nlp'],
    'Computer Vision': ['cv'],
    'Large Language Models': ['llm', 'llms'],
    'Generative AI': ['genai', 'gen ai'],
    'CI/CD': ['cicd', 'continuous integration', 'continuous delivery'],
    'REST APIs': ['rest', 'restful', 'rest api'],
    'Ruby on Rails': ['rails'],
    'ASP.NET': ['aspnet'],
    '.NET Core': ['dotnet', 'dotnet core', 'net core'],
    'Spring Boot': ['springboot'],
    'Scikit-learn': ['sklearn'],
    'Apache Spark': ['spark', 'pyspark'],
    'Apache Kafka': ['kafka'],
    'Apache Airflow': ['airflow'],
    'ELK Stack': ['elk', 'logstash', 'kibana'],
    'Infrastructure as Code': ['iac'],
    'Site Reliability Engineering': ['sre'],
    'Robotic Process Automation': ['rpa'],
    'Test-Driven Development': ['tdd'],
    'Behaviour-Driven Development': ['bdd', 'behavior-driven development'],
    'Power BI': ['powerbi'],
    'SAP ABAP': ['abap'],
    'Salesforce Apex': ['apex'],
    'Objective-C': ['objc'],
    'Unit Testing': ['unit tests'],
    'Test Automation': ['automation testing', 'automated testing'],
};

/**
 * The match key.
 *
 * MUST stay identical to slugify() in config/skills.js — the seed writes the
 * keys and the search reads them, and two different definitions of "the same
 * skill" is the exact bug this table was created to prevent.
 */
const slugify = (name) => String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9+#.]+/g, '-')
    .replace(/^-+|-+$/g, '');

export const runSeed007 = async (client) => {
    let skills = 0;
    const idBySlug = new Map();

    for (const [category, names] of Object.entries(SKILLS)) {
        for (const name of names) {
            const slug = slugify(name);
            const { rows } = await client.query(
                `INSERT INTO lkp_skills (name, slug, category, origin)
                 VALUES ($1,$2,$3,'SEED')
                 -- A skill already LEARNED from postings keeps its hit count;
                 -- this only upgrades its labelling to the curated spelling.
                 ON CONFLICT (slug) DO UPDATE
                    SET name = EXCLUDED.name,
                        category = EXCLUDED.category,
                        is_active = TRUE
                 RETURNING id`,
                [name, slug, category],
            );
            idBySlug.set(slug, rows[0].id);
            skills += 1;
        }
    }

    let aliases = 0;
    for (const [name, list] of Object.entries(ALIASES)) {
        const skillId = idBySlug.get(slugify(name));
        if (!skillId) continue;

        for (const alias of list) {
            await client.query(
                `INSERT INTO lkp_skill_aliases (skill_id, alias)
                 VALUES ($1,$2) ON CONFLICT (alias) DO NOTHING`,
                [skillId, slugify(alias)],
            );
            aliases += 1;
        }
    }

    console.log(`  ✓ ${skills} skills across ${Object.keys(SKILLS).length} categories, `
        + `${aliases} aliases`);
};
