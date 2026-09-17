db = db.getSiblingDB("knowledge_hub");

// Document content: _id (ObjectId) maps to kh_document.content_id, and documentId maps to kh_document.id.
db.createCollection("document_content");
db.document_content.createIndex({ documentId: 1 }, { unique: true });
db.document_content.createIndex({ deleted: 1 });
