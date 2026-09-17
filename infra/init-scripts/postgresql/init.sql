-- Document metadata table.
CREATE TABLE IF NOT EXISTS kh_document (
    id BIGINT PRIMARY KEY,
    title VARCHAR NOT NULL,
    content_id VARCHAR NOT NULL UNIQUE,
    summary VARCHAR,
    category_id BIGINT,
    team_id BIGINT,
    author_id BIGINT,
    cover_image VARCHAR,
    tags VARCHAR,
    status SMALLINT NOT NULL DEFAULT 0,
    remark VARCHAR,
    view_count INT NOT NULL DEFAULT 0,
    like_count INT NOT NULL DEFAULT 0,
    comment_count INT NOT NULL DEFAULT 0,
    favourite_count INT NOT NULL DEFAULT 0,
    word_count INT NOT NULL DEFAULT 0,
    publish_time TIMESTAMP,
    is_public BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    create_by BIGINT,
    update_by BIGINT,
    deleted BOOLEAN NOT NULL DEFAULT false
);

-- Document publication review records.
-- One row is created per submission; after approval or rejection, review_result
-- is no longer NULL and the row leaves the pending list.
CREATE TABLE IF NOT EXISTS kh_document_review (
    id BIGINT PRIMARY KEY,                          -- Review record ID (Snowflake).
    document_id BIGINT NOT NULL,                    -- Reviewed document ID -> kh_document.id.
    reviewer_id BIGINT,                             -- Reviewer ID; NULL while pending.
    reviewer_name VARCHAR,                          -- Reviewer name.
    review_result SMALLINT,                         -- NULL=pending, 1=approved, 2=rejected.
    review_comment VARCHAR,                         -- Review comment; required for rejection.
    before_status SMALLINT NOT NULL,                -- Document status before review (0=draft / 1=published).
    reviewed_at TIMESTAMP,                          -- Review completion time.
    created_at TIMESTAMP NOT NULL DEFAULT NOW()     -- Submission time.
);
-- Look up review history by document.
CREATE INDEX IF NOT EXISTS idx_kh_document_review_document_id ON kh_document_review(document_id);
-- Pending list: only rows where review_result IS NULL.
CREATE INDEX IF NOT EXISTS idx_kh_document_review_pending ON kh_document_review(review_result) WHERE review_result IS NULL;

-- ==================== Users and roles ====================

CREATE TABLE IF NOT EXISTS kh_user (
    id BIGINT PRIMARY KEY,                          -- User ID (Snowflake).
    username VARCHAR(50) NOT NULL,                  -- Login username.
    password VARCHAR(255) NOT NULL,                 -- Password (bcrypt hash).
    email VARCHAR(100),                             -- Optional email.
    real_name VARCHAR(50),                          -- Legal or display name.
    avatar VARCHAR(500),                            -- Avatar URL.
    email_verified SMALLINT NOT NULL DEFAULT 1,     -- 0=unverified, 1=verified.
    status SMALLINT NOT NULL DEFAULT 1,             -- 0=disabled, 1=enabled.
    last_login_at TIMESTAMP,                        -- Last login time.
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),    -- Creation time.
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),    -- Last update time.
    deleted BOOLEAN NOT NULL DEFAULT false          -- Soft-delete flag.
);
-- Unique username among non-deleted users.
CREATE UNIQUE INDEX IF NOT EXISTS uk_kh_user_username ON kh_user(username) WHERE deleted = false;

CREATE TABLE IF NOT EXISTS kh_role (
    id BIGINT PRIMARY KEY,                          -- Role ID (Snowflake).
    role_name VARCHAR(50) NOT NULL,                 -- Display name.
    role_code VARCHAR(50) NOT NULL UNIQUE,          -- Role code, such as ROLE_ADMIN / ROLE_REVIEWER / ROLE_USER.
    description VARCHAR(200),                     -- Role description.
    status SMALLINT NOT NULL DEFAULT 1              -- 0=disabled, 1=enabled.
);

CREATE TABLE IF NOT EXISTS kh_user_role (
    id BIGINT PRIMARY KEY,                          -- Association ID (Snowflake).
    user_id BIGINT NOT NULL REFERENCES kh_user(id), -- User ID.
    role_id BIGINT NOT NULL REFERENCES kh_role(id), -- Role ID.
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),    -- Assignment time.
    UNIQUE (user_id, role_id)
);
CREATE INDEX IF NOT EXISTS idx_kh_user_role_user_id ON kh_user_role(user_id);

-- Built-in roles.
INSERT INTO kh_role (id, role_name, role_code, description) VALUES
    (2000000000000000001, 'Administrator', 'ROLE_ADMIN', 'System administration'),
    (2000000000000000002, 'Reviewer', 'ROLE_REVIEWER', 'Document review'),
    (2000000000000000003, 'User', 'ROLE_USER', 'Default role')
ON CONFLICT (id) DO NOTHING;

-- Demo accounts (all passwords are 123456, bcrypt-hashed).
INSERT INTO kh_user (id, username, password, email, real_name, status) VALUES
    (1000000000000000001, 'admin', '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iKTVKIUi', 'admin@example.local', 'Admin', 1),
    (1000000000000000002, 'reviewer', '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iKTVKIUi', 'reviewer@example.local', 'Reviewer', 1),
    (1000000000000000003, 'user', '$2a$10$N.zmdr9k7uOCQb376NoUnuTJ8iAt6Z5EHsM8lE9lBOsl7iKTVKIUi', 'user@example.local', 'Demo User', 1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO kh_user_role (id, user_id, role_id) VALUES
    (3000000000000000001, 1000000000000000001, 2000000000000000001),  -- admin -> Administrator
    (3000000000000000002, 1000000000000000001, 2000000000000000002),  -- admin -> Reviewer
    (3000000000000000003, 1000000000000000002, 2000000000000000002),  -- reviewer -> Reviewer
    (3000000000000000004, 1000000000000000003, 2000000000000000003)   -- user -> User
ON CONFLICT (id) DO NOTHING;

-- ==================== RBAC permissions ====================

CREATE TABLE IF NOT EXISTS kh_permission (
    id BIGINT PRIMARY KEY,                          -- Permission ID (Snowflake).
    parent_id BIGINT NOT NULL DEFAULT 0,            -- Parent permission ID; 0 is the root.
    permission_name VARCHAR(50) NOT NULL,           -- Permission name.
    permission_code VARCHAR(100) NOT NULL UNIQUE,   -- Permission code used for runtime checks.
    permission_type SMALLINT NOT NULL,              -- 1=menu, 2=button, 3=API.
    menu_url VARCHAR(200),                          -- Menu path.
    api_url VARCHAR(500),                           -- API URL pattern.
    method VARCHAR(10),                             -- HTTP method.
    icon VARCHAR(50),                               -- Icon.
    sort INT NOT NULL DEFAULT 0,
    status SMALLINT NOT NULL DEFAULT 1,             -- 0=disabled, 1=enabled.
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    deleted BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS kh_role_permission (
    id BIGINT PRIMARY KEY,
    role_id BIGINT NOT NULL REFERENCES kh_role(id),
    permission_id BIGINT NOT NULL REFERENCES kh_permission(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS kh_user_permission (
    id BIGINT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES kh_user(id),
    permission_id BIGINT NOT NULL REFERENCES kh_permission(id),
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, permission_id)
);

INSERT INTO kh_permission (id, parent_id, permission_name, permission_code, permission_type, menu_url, icon, sort) VALUES
    (4000000000000000001, 0, 'Home', 'dashboard', 1, '/dashboard', 'DashboardOutlined', 1),
    (4000000000000000002, 0, 'Documents', 'document', 1, '/documents', 'FileTextOutlined', 2),
    (4000000000000000003, 0, 'Search', 'search', 1, '/search', 'SearchOutlined', 3),
    (4000000000000000004, 0, 'Profile', 'profile', 1, '/profile', 'UserOutlined', 4),
    (4000000000000000005, 0, 'Administration', 'system', 1, '/admin', 'SettingOutlined', 5)
ON CONFLICT (id) DO NOTHING;

INSERT INTO kh_permission (id, parent_id, permission_name, permission_code, permission_type, sort) VALUES
    (4000000000000000011, 4000000000000000002, 'Document list', 'document:list', 2, 1),
    (4000000000000000012, 4000000000000000002, 'Create document', 'document:create', 2, 2),
    (4000000000000000013, 4000000000000000002, 'Edit document', 'document:edit', 2, 3),
    (4000000000000000014, 4000000000000000002, 'Delete document', 'document:delete', 2, 4),
    (4000000000000000015, 4000000000000000002, 'Review document', 'document:review', 2, 5)
ON CONFLICT (id) DO NOTHING;

INSERT INTO kh_permission (id, parent_id, permission_name, permission_code, permission_type, menu_url, sort) VALUES
    (4000000000000000021, 4000000000000000005, 'User management', 'system:user', 1, '/admin/users', 1),
    (4000000000000000022, 4000000000000000005, 'Role management', 'system:role', 1, '/admin/roles', 2),
    (4000000000000000023, 4000000000000000005, 'Permission management', 'system:permission', 1, '/admin/permissions', 3),
    (4000000000000000024, 4000000000000000005, 'Team management', 'system:team', 1, '/admin/teams', 4)
ON CONFLICT (id) DO NOTHING;

INSERT INTO kh_permission (id, parent_id, permission_name, permission_code, permission_type, sort) VALUES
    (4000000000000000041, 4000000000000000023, 'Create permission', 'system:permission:create', 2, 1),
    (4000000000000000042, 4000000000000000023, 'Edit permission', 'system:permission:edit', 2, 2),
    (4000000000000000043, 4000000000000000023, 'Delete permission', 'system:permission:delete', 2, 3)
ON CONFLICT (id) DO NOTHING;

INSERT INTO kh_role_permission (id, role_id, permission_id) VALUES
    (4100000000000000001, 2000000000000000002, 4000000000000000011),
    (4100000000000000002, 2000000000000000002, 4000000000000000015),
    (4100000000000000003, 2000000000000000003, 4000000000000000001),
    (4100000000000000004, 2000000000000000003, 4000000000000000002),
    (4100000000000000005, 2000000000000000003, 4000000000000000011),
    (4100000000000000006, 2000000000000000003, 4000000000000000012),
    (4100000000000000007, 2000000000000000003, 4000000000000000003),
    (4100000000000000008, 2000000000000000003, 4000000000000000004),
    (4100000000000000009, 2000000000000000003, 4000000000000000013),
    (4100000000000000010, 2000000000000000003, 4000000000000000014),
    (4100000000000000011, 2000000000000000002, 4000000000000000003)
ON CONFLICT (id) DO NOTHING;

-- ==================== Teams ====================

CREATE TABLE IF NOT EXISTS kh_team (
    id BIGINT PRIMARY KEY,                          -- Team ID (Snowflake).
    team_name VARCHAR(100) NOT NULL,                -- Team name.
    team_code VARCHAR(50),                          -- Team code.
    description VARCHAR(500),                       -- Description.
    leader_id BIGINT,                               -- Team leader -> kh_user.id.
    parent_id BIGINT NOT NULL DEFAULT 0,            -- Parent team ID; 0 is the root.
    sort INT NOT NULL DEFAULT 0,                    -- Sort order.
    status SMALLINT NOT NULL DEFAULT 1,             -- 0=disabled, 1=enabled.
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    deleted BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS idx_kh_team_parent_id ON kh_team(parent_id);

CREATE TABLE IF NOT EXISTS kh_team_member (
    id BIGINT PRIMARY KEY,                          -- Association ID (Snowflake).
    team_id BIGINT NOT NULL REFERENCES kh_team(id),
    user_id BIGINT NOT NULL REFERENCES kh_user(id),
    member_role VARCHAR(20) NOT NULL DEFAULT 'member', -- leader / member
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE (team_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_kh_team_member_user_id ON kh_team_member(user_id);

INSERT INTO kh_team (id, team_name, team_code, description, leader_id, parent_id, sort) VALUES
    (8000000000000000001, 'Technology Center', 'TECH_CENTER', 'Research and engineering team', 1000000000000000001, 0, 1),
    (8000000000000000002, 'Backend Team', 'BACKEND_TEAM', 'Backend engineering', 1000000000000000001, 8000000000000000001, 1)
ON CONFLICT (id) DO NOTHING;

INSERT INTO kh_team_member (id, team_id, user_id, member_role) VALUES
    (9000000000000000001, 8000000000000000001, 1000000000000000001, 'leader'),
    (9000000000000000002, 8000000000000000002, 1000000000000000001, 'leader'),
    (9000000000000000003, 8000000000000000002, 1000000000000000003, 'member')
ON CONFLICT (id) DO NOTHING;

-- ==================== AI sessions ====================

CREATE TABLE IF NOT EXISTS kh_ai_session (
    id BIGINT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    title VARCHAR(80) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kh_ai_session_user_updated
    ON kh_ai_session(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS kh_ai_message (
    id BIGINT PRIMARY KEY,
    session_id BIGINT NOT NULL REFERENCES kh_ai_session(id) ON DELETE CASCADE,
    role VARCHAR(16) NOT NULL,
    content TEXT NOT NULL,
    sources JSONB,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kh_ai_message_session_id
    ON kh_ai_message(session_id, created_at);
