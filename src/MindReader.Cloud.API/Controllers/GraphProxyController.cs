using Asp.Versioning;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using MindReader.Cloud.Application.Common.Interfaces;

namespace MindReader.Cloud.API.Controllers;

[ApiVersion("1.0")]
[Authorize]
[Route("api/v{version:apiVersion}/graph")]
public class GraphProxyController : ApiControllerBase
{
    private readonly IGraphProxyService _proxy;
    private readonly ITenantService _tenant;
    private readonly IUsageLimitService _usage;
    private readonly ILogger<GraphProxyController> _logger;

    public GraphProxyController(IGraphProxyService proxy, ITenantService tenant, IUsageLimitService usage, ILogger<GraphProxyController> logger)
    {
        _proxy = proxy;
        _tenant = tenant;
        _usage = usage;
        _logger = logger;
    }

    /// <summary>
    /// Proxy GET requests to MindReader Express
    /// </summary>
    [HttpGet("{**path}")]
    public async Task<IActionResult> ProxyGet(string path)
    {
        var fullPath = $"/api/{path}{Request.QueryString}";
        var response = await _proxy.ForwardAsync(fullPath, HttpMethod.Get, null, _tenant.CurrentTenantId);
        var content = await response.Content.ReadAsStringAsync();
        return Content(content, "application/json", System.Text.Encoding.UTF8);
    }

    /// <summary>
    /// Proxy POST requests to MindReader Express (with usage limit checks)
    /// </summary>
    [HttpPost("{**path}")]
    public async Task<IActionResult> ProxyPost(string path)
    {
        using var reader = new StreamReader(Request.Body);
        var body = await reader.ReadToEndAsync();
        var fullPath = $"/api/{path}";

        // Check usage limits for specific operations
        var tenantRecord = await GetTenantRecord();
        if (path.Contains("evolve") && tenantRecord != null)
        {
            var canEvolve = await _usage.CanPerformAsync(tenantRecord.Id, Domain.Enums.OperationType.Evolve);
            if (!canEvolve)
                return StatusCode(429, new { error = "Daily evolve limit reached. Upgrade to continue." });
        }

        var response = await _proxy.ForwardAsync(fullPath, HttpMethod.Post, body, _tenant.CurrentTenantId);

        // Record usage after successful operation
        if (response.IsSuccessStatusCode && path.Contains("evolve") && tenantRecord != null)
        {
            await _usage.RecordUsageAsync(tenantRecord.Id, Domain.Enums.OperationType.Evolve);
        }

        var content = await response.Content.ReadAsStringAsync();
        return Content(content, response.Content.Headers.ContentType?.MediaType ?? "application/json", System.Text.Encoding.UTF8);
    }

    /// <summary>
    /// Proxy PUT requests to MindReader Express
    /// </summary>
    [HttpPut("{**path}")]
    public async Task<IActionResult> ProxyPut(string path)
    {
        using var reader = new StreamReader(Request.Body);
        var body = await reader.ReadToEndAsync();
        var fullPath = $"/api/{path}";
        var response = await _proxy.ForwardAsync(fullPath, HttpMethod.Put, body, _tenant.CurrentTenantId);
        var content = await response.Content.ReadAsStringAsync();
        return Content(content, "application/json", System.Text.Encoding.UTF8);
    }

    /// <summary>
    /// Proxy DELETE requests to MindReader Express
    /// </summary>
    [HttpDelete("{**path}")]
    public async Task<IActionResult> ProxyDelete(string path)
    {
        var fullPath = $"/api/{path}";
        var response = await _proxy.ForwardAsync(fullPath, HttpMethod.Delete, null, _tenant.CurrentTenantId);
        var content = await response.Content.ReadAsStringAsync();
        return Content(content, "application/json", System.Text.Encoding.UTF8);
    }

    /// <summary>
    /// GET /api/v1/graph/usage — Get usage summary for current tenant
    /// </summary>
    [HttpGet("~/api/v{version:apiVersion}/usage")]
    public async Task<IActionResult> GetUsage()
    {
        var tenantRecord = await GetTenantRecord();
        if (tenantRecord == null) return NotFound(new { error = "Tenant not found" });
        var summary = await _usage.GetUsageSummaryAsync(tenantRecord.Id);
        return Ok(summary);
    }

    private async Task<Domain.Entities.Tenant?> GetTenantRecord()
    {
        var tenantId = _tenant.CurrentTenantId;
        var db = HttpContext.RequestServices.GetRequiredService<ICloudDbContext>();
        return await db.Tenants.FirstOrDefaultAsync(t => t.Neo4jTenantId == tenantId);
    }
}
