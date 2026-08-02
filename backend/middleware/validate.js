/**
 * Joi validation middleware.
 *
 *   app.post('/x', [verifyToken, isOrgAdmin, validate(schema)], handler)
 *
 * Strips unknown keys so a client cannot smuggle extra fields (organization_id,
 * role escalation, is_active) into an INSERT or UPDATE.
 */
export const validate = (schema, property = 'body') => (req, res, next) => {
    const { error, value } = schema.validate(req[property], {
        abortEarly: false,
        stripUnknown: true,
        convert: true,
    });

    if (error) {
        return res.status(422).json({
            error: 'Validation failed.',
            details: error.details.map((d) => ({
                field: d.path.join('.'),
                message: d.message.replace(/"/g, ''),
            })),
        });
    }

    req[property] = value;
    return next();
};
