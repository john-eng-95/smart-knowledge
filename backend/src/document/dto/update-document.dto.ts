import { PartialType } from '@nestjs/mapped-types';
import { CreateDocumentDto } from './create-document.dto';

/** Update a document (all fields are optional; author/updater come from the authenticated user). */
export class UpdateDocumentDto extends PartialType(CreateDocumentDto) {}
