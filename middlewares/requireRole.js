function requireRole(roles = []) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: "Unauthorized",
      });
    }
    
    const userRole = String(req.user.role || "").toLowerCase();
    const allowedRoles = roles.map((r) => String(r).toLowerCase());

    if (!allowedRoles.includes(userRole)) {
      return res.status(403).json({
        success: false,
        message: "Forbidden",
      });
    }
    
    next();
  };
}

module.exports = requireRole;
